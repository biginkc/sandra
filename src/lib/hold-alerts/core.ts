import { reportError } from "@/lib/errors/report";
import { HOT_ALERTS_START_ISO, HOT_HANDOFF_FAILED_REASONS, hotFailedKey, hotFlagKey, hotTextKey } from "@/lib/hot-sellers/hot";

import { digestMessage, hotPromotionSlackText, hotPromotionSmsText, slackFirstText, smsText } from "./messages";
import {
  MAX_ATTEMPTS,
  ROUTE_MAX_DURATION_MS,
  type ChannelResult,
  type EmailMessage,
  type EnsureInput,
  type HoldAlertDeps,
  type CapBucket,
  type HoldInfo,
  type OrgAlertSummary,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
/** PLAN 4.7 caps. */
export const MAX_DMS_PER_RECIPIENT_PER_HOUR = 500;
export const MAX_SMS_PER_HOUR = 500;
export const DEFAULT_BUDGET_MS = 50_000;
/**
 * No new task starts once fewer than this many ms of the budget remain: a task started late could run past
 * the route's 60s limit and die mid-send as failed:interrupted, silently losing a hot alert.
 */
export const TASK_START_RESERVE_MS = 15_000;
export { HOT_ALERTS_START_ISO };

type Task = {
  input: EnsureInput;
  send: (ctx: { deliveryId: string }) => Promise<ChannelResult>;
  /** The recipient must still be an owner when the send happens (SMS). */
  requireOwner?: boolean;
};

/** A hold may alert only when it began at or after the watermark. No known start never does. */
export function isNewHold(hold: Pick<HoldInfo, "startedAt">, alertsSinceMs: number): boolean {
  if (!hold.startedAt || !Number.isFinite(alertsSinceMs)) return false;
  const startedMs = Date.parse(hold.startedAt);
  return Number.isFinite(startedMs) && startedMs >= alertsSinceMs;
}

/**
 * Immediately before a hot provider call: re-resolve Jarrad and require the
 * same person this pass selected. Changed or ambiguous → skip; a failed lookup
 * → retryable failure (nothing was sent).
 */
async function hotOwnerStillIs(
  deps: HoldAlertDeps,
  orgId: string,
  owner: string,
): Promise<ChannelResult | null> {
  let current: string | null;
  try {
    current = await deps.loadHotOwner(orgId);
  } catch (error) {
    return { status: "failed", error: `hot owner re-check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (current !== owner) {
    reportError(new Error("hold alerts: hot owner changed or ambiguous at send time; not sent"), {
      tags: { surface: "hold_alerts", orgId },
    });
    return { status: "skipped", reason: current === null ? "hot_owner_ambiguous" : "hot_owner_changed" };
  }
  return null;
}

/** "Couldn't tell who to alert" is reported once per org per hour (per instance), not every pass. */
const reportedThisHour = new Map<string, number>();
function shouldReportOnce(key: string, nowMs: number): boolean {
  const hour = Math.floor(nowMs / HOUR_MS);
  if (reportedThisHour.get(key) === hour) return false;
  reportedThisHour.set(key, hour);
  return true;
}
const shouldReportOwnerUnknown = (orgId: string, nowMs: number) => shouldReportOnce(orgId, nowMs);

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
  hotOwnerUnknown: false,
});

/**
 * One alert pass for one org: derive tasks (one Slack DM + one SMS to Jarrad
 * per hot hold and per hot promotion, hourly email digest), then run each through
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

  // Alerts are for holds that START after they were enabled. A new org's
  // watermark starts no later than HOT_ALERTS_START_ISO, so a hot seller that
  // arrived before the first pass still alerts on it; older backlog stays silent.
  const nowIso = deps.now().toISOString();
  // The cutoff is authoritative: a new org's watermark is HOT_ALERTS_START_ISO
  // (or now, if the clock is somehow before it), so every post-cutoff hot hold
  // is covered; delivery keys keep each one to a single alert.
  const initIso = Date.parse(nowIso) > Date.parse(HOT_ALERTS_START_ISO) ? HOT_ALERTS_START_ISO : nowIso;
  const mark = await deps.store.getOrInitAlertsSince(orgId, initIso);
  const alertsSinceMs = Date.parse(mark.alertsSince);

  const loaded = await deps.loadHolds(orgId, mark.alertsSince);
  // An incomplete load (a query failed or hit its row cap) may be missing holds: say so, once per run.
  if (!loaded.complete) {
    reportError(new Error("hold alerts: alert-source load incomplete; some holds may not have alerted"), {
      tags: { surface: "hold_alerts", orgId },
    });
  }
  const holds = loaded.holds.filter((h) => isNewHold(h, alertsSinceMs));
  // Archive-on-clear: a property that is no longer held closes its delivery
  // rows so a re-opened hold gets fresh keys. Bounded and independent of the
  // alert load: look only at properties that have live delivery rows, ask which
  // are still held, and archive the rest. Any incomplete answer archives nothing.
  // Hot-promotion rows carry no property_id, so they are never archived (once per property, ever).
  const delivered = await deps.store.deliveredPropertyIds(orgId);
  if (delivered.complete && delivered.ids.length > 0) {
    const held = await deps.loadHeldPropertyIds(orgId, delivered.ids);
    if (held) {
      // Scope to what THIS run saw as delivered and not open: rows a concurrent run
      // ensured after the listing are never candidates, so they cannot be archived here.
      const open = new Set([...held, ...loaded.holds.map((h) => h.propertyId)]);
      summary.archived = await deps.store.archiveClosed(orgId, [...open], delivered.ids);
    }
  }
  const promoted = await deps.loadHotPromotions(orgId, mark.alertsSince);
  if (!promoted.complete) {
    reportError(new Error("hold alerts: hot-promotion load incomplete; some hot sellers may not have alerted"), {
      tags: { surface: "hold_alerts", orgId },
    });
  }
  const promotions = promoted.promotions.filter(
    (p) => isNewHold({ startedAt: p.assignedAt }, alertsSinceMs) && isNewHold({ startedAt: p.assignedAt }, Date.parse(HOT_ALERTS_START_ISO)),
  );
  summary.holds = holds.length;
  const hotStartMs = Date.parse(HOT_ALERTS_START_ISO);
  // A hot hold's own moment is its flag time (falls back to its start): the
  // cutoff and the alert key use it, never later activity on the lead.
  // Design B: a hot hold alerts on its own verified hot moment.
  //  - flag reason itself hot → hot_flag:<property>:<flagAt>, cutoff on flagAt;
  //  - else the hold's run is hot → hot_text:<run inbound>, cutoff on the run's start;
  //  - no verifiable hot time → fail closed (not alerted, reported).
  // A failed hand-off hold is alerted by its own event instead.
  type HotHoldAlert = { hold: HoldInfo; key: string; at: string };
  // A failed hand-off whose FLAG is the failure is a normal hot flag hold:
  // hot_flag:<property>:<flagAt>, stable while open (later texts never re-key
  // it), and its own event carries the same key. Only when the flag write
  // no-oped (a non-hot flag was already open) is it keyed by its run,
  // hot_failed:<run inbound>, again matching its event. Either way the hold
  // alerts even if the event could not be written, and they dedupe.
  const isFailedReason = (v: string | null | undefined) => HOT_HANDOFF_FAILED_REASONS.includes(v ?? "");
  const hotCandidates = holds.filter((h) => h.hot);
  const hotAlerts: HotHoldAlert[] = [];
  let unverified = 0;
  for (const h of hotCandidates) {
    const failedByRunOnly = !h.flagHot && isFailedReason(h.runReason);
    if (failedByRunOnly && h.runInbound && h.runStartedAt) hotAlerts.push({ hold: h, key: hotFailedKey(h.runInbound), at: h.runStartedAt });
    else if (h.flagHot && h.flagAt) hotAlerts.push({ hold: h, key: hotFlagKey(h.propertyId, h.flagAt), at: h.flagAt });
    else if (!h.flagHot && h.runHot && h.runInbound && h.runStartedAt) hotAlerts.push({ hold: h, key: hotTextKey(h.runInbound), at: h.runStartedAt });
    else unverified += 1;
  }
  if (unverified > 0 && shouldReportOnce(`unverified:${orgId}`, startMs)) {
    reportError(new Error("hold alerts: hot hold without a verified hot time; not alerted"), {
      tags: { surface: "hold_alerts", orgId },
      extra: { count: unverified },
    });
  }
  const hotHolds = hotAlerts.filter((a) => isNewHold({ startedAt: a.at }, hotStartMs));
  if (hotHolds.length === 0 && promotions.length === 0 && !(deps.emailEnabled && holds.length > 0)) return summary;

  const recipients = await deps.loadRecipients(orgId);
  const link = deps.baseUrl;
  const nowMs = startMs;
  const base = { orgId };
  const tasks: Task[] = [];

  // PR 2 (Jarrad 2026-10-14): only hot sellers ping, and only Jarrad: one Slack
  // DM + one text per hot hold or hot promotion. Non-hot holds send nothing per
  // hold (no first DM, no 1h nudge); they stay on the page and in the digest.
  // Jarrad = the org's one active owner. Unknown (several owners, or the lookup
  // failed) → fail closed: no hot hold alerts this pass, said out loud. The
  // digest still goes. Promotions follow the same rule.
  let hotOwner: string | null = null;
  try {
    hotOwner = await deps.loadHotOwner(orgId);
  } catch (error) {
    reportError(error, { tags: { surface: "hold_alerts", orgId }, extra: { stage: "hot_owner" } });
  }
  if (hotOwner === null && (hotHolds.length > 0 || promotions.length > 0)) {
    summary.hotOwnerUnknown = true;
    if (shouldReportOwnerUnknown(orgId, startMs)) reportError(new Error("hold alerts: couldn't tell who to alert for hot sellers; none sent"), {
      tags: { surface: "hold_alerts", orgId },
      extra: { hotHolds: hotHolds.length, promotions: promotions.length },
    });
  }
  const hotRecipients = recipients.filter((r) => r.role === "owner" && r.userId === hotOwner);
  // One alert per hot EVENT (see "Alert and hand-off model" in PR #882):
  // hot_handoff:<inbound>, hot_text:<inbound>, hot_flag:<property>:<flagAt>.
  // property_id null so archive-on-clear never re-fires a key.
  for (const p of promotions) {
    // Same fail-closed rule as holds: only to the resolved hot owner, who must be
    // the promotion's assignee AND still own the property when the send happens.
    if (hotOwner === null) continue;
    // Owner decision 2026-10-19: every hot alert goes to Jarrad, whoever the
    // lead is assigned to (or unassigned). Assignment never gates the alert.
    if (!hotRecipients.some((r) => r.userId === hotOwner)) continue;
    const owner = hotOwner;
    for (const channel of ["slack", "sms"] as const) {
      tasks.push({
        input: { ...base, propertyId: null, holdKey: p.key, recipientUserId: owner, channel, stage: "first" },
        send: async () => {
          // Before any provider call, so a failed check is cleanly retryable.
          const ownerCheck = await hotOwnerStillIs(deps, orgId, owner);
          if (ownerCheck) return ownerCheck;
          return channel === "slack"
            ? deps.sendSlack(owner, hotPromotionSlackText(p, link))
            : deps.sendSms(owner, hotPromotionSmsText(p, link));
        },
        requireOwner: true,
      });
    }
  }
  for (const { hold, key } of hotHolds) {
    for (const r of hotRecipients) {
      for (const channel of ["slack", "sms"] as const) {
        tasks.push({
          input: { ...base, propertyId: null, holdKey: key, recipientUserId: r.userId, channel, stage: "first" },
          send: async () => {
            const ownerCheck = await hotOwnerStillIs(deps, orgId, r.userId);
            if (ownerCheck) return ownerCheck;
            // Every hot hold pings Jarrad, whoever has the lead (owner decision 2026-10-19).
            return channel === "slack" ? deps.sendSlack(r.userId, slackFirstText(hold, link)) : deps.sendSms(r.userId, smsText(hold, link));
          },
          requireOwner: true,
        });
      }
    }
  }
  if (deps.emailEnabled && holds.length > 0) {
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
    if (deps.now().getTime() - startMs >= budgetMs - TASK_START_RESERVE_MS) {
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
  const row = await store.ensure(task.input);
  const claimable = (row.status === "pending" || row.status === "failed") && row.attempts < MAX_ATTEMPTS;
  if (!claimable) return "untouched";

  // Capped channels: the cap check and the claim are ONE atomic database step
  // (hold_alert_claim_with_cap, advisory-locked per cap bucket), so two
  // overlapping passes can never both send into the last free slot. Over the
  // cap → the row stays pending (no attempt spent) for the next pass.
  const cap = capFor(deps, task.input);
  if (cap) {
    let result: "claimed" | "capped" | "lost";
    try {
      result = await store.claimWithCap(row, cap);
    } catch (error) {
      // Nothing was claimed or sent: the row stays pending for the next pass,
      // and the rest of this pass carries on.
      reportError(error, { tags: { surface: "hold_alerts" }, extra: { stage: "claim_with_cap", deliveryId: row.id } });
      return "deferred";
    }
    if (result === "capped") return "deferred";
    if (result !== "claimed") return "untouched";
  } else if (!(await store.claim(row))) {
    return "untouched";
  }

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

/** The hourly cap bucket for a delivery (null = uncapped channel, e.g. email). */
function capFor(deps: HoldAlertDeps, input: EnsureInput): CapBucket | null {
  const sinceIso = new Date(deps.now().getTime() - HOUR_MS).toISOString();
  if (input.channel === "slack") {
    return { orgId: input.orgId, channel: "slack", recipientUserId: input.recipientUserId, cap: MAX_DMS_PER_RECIPIENT_PER_HOUR, sinceIso };
  }
  if (input.channel === "sms") {
    return { orgId: input.orgId, channel: "sms", recipientUserId: null, cap: MAX_SMS_PER_HOUR, sinceIso };
  }
  return null;
}
