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
   *  Semantics differ by which claim produced this row (see
   *  `attemptsAlreadyBumped`): from `fn_claim_appointment_reminders` (fresh
   *  insert) this is the attempt count BEFORE this delivery (table default
   *  0), and `markDelivery` writes `attempts + 1`. From
   *  `fn_claim_reminder_retries` the claim itself already bumped attempts
   *  atomically (Codex round 1, same convention as
   *  `task_calendar_mutations`'s claim), so this IS the attempt count for
   *  this delivery and `markDelivery` writes it as-is. */
  attempts: number;
  /** True for a row from `fn_claim_reminder_retries` (attempts already
   *  bumped by the claim itself); false for a fresh row from
   *  `fn_claim_appointment_reminders` (this delivery IS attempt
   *  `attempts + 1`, not yet reflected in `attempts`). Purely an
   *  attempts-bookkeeping distinction now — see `claimToken` below for why
   *  it no longer also gates fencing. */
  attemptsAlreadyBumped: boolean;
  /** Fencing token minted by the claim RPC — by `fn_claim_reminder_retries`
   *  on a reclaim, or (Codex round 2 fix) by `fn_claim_appointment_reminders`
   *  itself on the initial insert. Before round 2, a fresh row from the
   *  primary claim carried no token, so its own sent/failed write was
   *  scoped only by delivery id; once the stale-pending retry claim
   *  reclaimed the same row (still status=pending, now with a fresh
   *  token) after 10 minutes, a slow initial provider call finishing late
   *  could race the retry owner's write with no fencing between them.
   *  Every claimed row now carries a token, and `markDelivery`'s write is
   *  unconditionally scoped `WHERE id=<mine> AND claim_token=<mine> AND
   *  status=<claimedStatus>` — a stalled worker whose lease was reclaimed
   *  (by a retry claim, or a later retry-of-the-retry) writes zero rows
   *  instead of clobbering the new owner. */
  claimToken: string;
  /** The delivery's status as of just before this claim ('pending' for
   *  every fresh row and most retries, or 'failed' for a retry of a
   *  previously-failed delivery) — the "expected status" half of the
   *  fenced write. */
  claimedStatus: "pending" | "failed";
  taskTitle: string;
  taskDueAt: string;
  taskEndAt: string | null;
  assigneeId: string;
  assigneeTimezone: string;
  assigneeReminderPhone: string | null;
  /** Codex round 4 (finding 3): only ever non-null on a row from
   *  `fn_claim_reminder_retries` whose PREVIOUS attempt already reached
   *  Slack/Sendillo (got a provider message id back) and then crashed
   *  before its own mark-sent write landed. Slack/SMS have no send-side
   *  idempotency key (see `deliverSlack`/`deliverSms`'s doc comments), so
   *  re-sending on a retry would risk a real duplicate message; when this
   *  is set, the channel handler skips the provider call entirely and
   *  reconciles (marks sent using this same id) instead. Always null for a
   *  fresh row from `fn_claim_appointment_reminders`, and always null for
   *  bell (dedup there comes from the notifications unique index, not
   *  this field). */
  providerMessageId: string | null;
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

/** Codex round 4 (finding 3): bounded retry for the mark-sent write. A
 *  crash between a successful Slack/Sendillo send and this write landing
 *  is the one place a real message already went out but our own
 *  bookkeeping doesn't know it — leaving the row retryable would (absent
 *  the round 4 reconciliation-on-retry check in `deliverSlack`/
 *  `deliverSms` below) risk sending it again. A handful of quick retries
 *  against a transient DB blip closes most of that window cheaply; ONLY
 *  after they're all exhausted does the row fall back to the pre-round-4
 *  posture (left retryable, reported with a duplicate-risk tag). */
const MARK_DELIVERY_WRITE_ATTEMPTS = 3;
const MARK_DELIVERY_RETRY_BACKOFF_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes the delivery outcome. Codex round 2 fix: every row — whether from
 * `fn_claim_appointment_reminders` (initial) or `fn_claim_reminder_retries`
 * (retry) — now carries a `claim_token`/`claimedStatus`, so the write is
 * unconditionally fenced — scoped `WHERE id=<mine> AND claim_token=<mine>
 * AND status=<claimedStatus>` and verified to affect exactly one row
 * (`.select("id")`) — same contract as `task_calendar_mutations`'s
 * `applyLedgerTransition` (create-worker.ts). Zero rows matched means the
 * lease was lost — reclaimed by a later sweep (retry-of-a-retry) after this
 * worker stalled past its 2-minute lease, OR by the stale-pending retry
 * claim taking over an initial delivery that stalled past ITS lease: not an
 * error, the row is abandoned silently — ownership belongs to whoever holds
 * the current token, and their own delivery attempt (or lack thereof) is
 * authoritative. That's not something a retry loop can fix (the fencing
 * predicate will never start matching again), so only a genuine write
 * ERROR (transient DB failure) triggers a retry attempt here — a clean
 * zero-rows result returns immediately on the first try, same as before.
 *
 * `attempts` written is `row.attempts` as-is when `attemptsAlreadyBumped`
 * (the retry claim already bumped it) and `row.attempts + 1` otherwise (a
 * fresh initial-claim row, whose attempts the claim itself never touches).
 * See `ClaimedReminderRow.attemptsAlreadyBumped`.
 */
async function markDelivery(
  supabase: SupabaseClient<Database>,
  row: Pick<
    ClaimedReminderRow,
    "deliveryId" | "attempts" | "attemptsAlreadyBumped" | "claimToken" | "claimedStatus"
  >,
  status: "sent" | "failed",
  extra: { providerMessageId?: string | null; lastError?: string | null },
): Promise<void> {
  const attempts = row.attemptsAlreadyBumped ? row.attempts : row.attempts + 1;
  const values = {
    status,
    attempts,
    provider_message_id: extra.providerMessageId ?? null,
    last_error: extra.lastError ?? null,
    sent_at: status === "sent" ? new Date().toISOString() : null,
  };

  let lastErrorMessage: string | null = null;
  for (let attempt = 1; attempt <= MARK_DELIVERY_WRITE_ATTEMPTS; attempt += 1) {
    const { error } = await (supabase as unknown as DeliveryUpdateClient)
      .from("task_reminder_deliveries")
      .update(values)
      .eq("id", row.deliveryId)
      .eq("claim_token", row.claimToken)
      .eq("status", row.claimedStatus)
      .select("id");

    if (!error) {
      // Success (including the legitimate 0-rows "lease lost" case — see
      // the doc comment above for why that's not retried; the caller
      // never distinguishes the two, so the row count isn't inspected).
      return;
    }

    lastErrorMessage = error.message;
    if (attempt < MARK_DELIVERY_WRITE_ATTEMPTS) {
      await sleep(MARK_DELIVERY_RETRY_BACKOFF_MS * attempt);
    }
  }

  {
    // Codex round 4 (finding 3): a `status: "sent"` write that never
    // durably lands, WITH a provider_message_id, is the specific
    // duplicate-risk case — the provider call already succeeded, so a
    // future retry claim will attempt to send again unless it can see
    // that id (which it can't, since this write is exactly the one that
    // would have persisted it). Tagged distinctly so this is triageable
    // apart from ordinary mark-failed write errors, which carry no such
    // risk (the row staying retryable there is simply correct).
    const duplicateRisk = status === "sent" && Boolean(extra.providerMessageId);
    reportError(new Error(lastErrorMessage ?? "mark delivery failed"), {
      tags: {
        surface: "reminder_delivery_mark",
        ...(duplicateRisk ? { duplicate_risk: true } : {}),
      },
      extra: { deliveryId: row.deliveryId, status },
    });
    return;
  }
}

/**
 * Codex round 6 (finding 2): the sweep route (route.ts) races each
 * slack/sms delivery against a deadline derived from the remaining phase
 * budget — a single provider call with no bound could otherwise blow
 * through the phase boundary or the whole 45s sweep budget (the Slack SDK
 * has no default request timeout; Sendillo's HTTP client is likewise
 * unbounded here). When the race times out, the route calls this to record
 * a retryable failure using the SAME fenced write as every other outcome
 * (`markDelivery`, scoped by `claim_token`/`claimedStatus`) — so if the
 * abandoned call later actually lands (success or failure), ITS OWN write
 * simply no-ops (the row already moved off the expected status). That
 * leaves one accepted gap: a timed-out delivery that later actually
 * succeeds records neither the real provider_message_id nor a "sent"
 * status, so a subsequent retry claim (attempts<3) will re-send rather
 * than reconcile — the same duplicate-risk category `deliverSlack`/
 * `deliverSms`'s own doc comments already carry for crash-before-write,
 * not a new failure mode this introduces.
 */
export async function markReminderDeliveryTimedOut(
  supabase: SupabaseClient<Database>,
  row: Pick<
    ClaimedReminderRow,
    "deliveryId" | "attempts" | "attemptsAlreadyBumped" | "claimToken" | "claimedStatus"
  >,
): Promise<void> {
  await markDelivery(supabase, row, "failed", { lastError: "delivery timeout" });
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
  // Codex round 4 (finding 3): Slack's Web API has no client-supplied
  // idempotency/dedupe key for chat.postMessage — a re-send is a real
  // second message, not a safely-ignored duplicate (documented at the top
  // of `sendillo.ts`'s send-side investigation for the SMS half of this
  // same finding; Slack was never in scope for that check, but carries
  // the identical risk). If a PRIOR attempt already reached Slack —
  // `providerMessageId` set by `fn_claim_reminder_retries` off this row's
  // own `provider_message_id` column — this crashed only on its own
  // mark-sent write, not on the send. Reconcile instead of re-sending.
  if (row.providerMessageId) {
    await markDelivery(supabase, row, "sent", { providerMessageId: row.providerMessageId });
    return {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "slack",
      providerMessageId: row.providerMessageId,
    };
  }

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
  // Codex round 4 (finding 3): investigated whether Sendillo's outbound
  // send API (`POST /api/v1/messages`, see `sendSms` in
  // `src/lib/messaging/providers/sendillo.ts`) accepts a client-supplied
  // reference/idempotency field to key by `row.deliveryId` and get
  // provider-side dedupe on a re-send. It does not: the confirmed public
  // OpenAPI/request shape is `{ from, to, body }` only (no
  // clientReference/idempotencyKey/externalId-on-send field), and the
  // adapter's own send-side code sends exactly that payload — see
  // `docs/handoff/2026-06-08-sendillo-adapter-status.md` for the fuller
  // evidence trail on what Sendillo's docs do and don't confirm. So the
  // SAME posture as Slack applies here: if a PRIOR attempt's send already
  // reached Sendillo (`providerMessageId` off this row's own
  // `provider_message_id` column, populated by `fn_claim_reminder_retries`)
  // and only crashed on its own mark-sent write, reconcile instead of
  // calling `sendRepSmsReminder` again — a real second SMS is not a safely
  // ignored duplicate.
  if (row.providerMessageId) {
    await markDelivery(supabase, row, "sent", { providerMessageId: row.providerMessageId });
    return {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "sms",
      providerMessageId: row.providerMessageId,
    };
  }

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
