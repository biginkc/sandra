import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import {
  buildAppointmentDeepLink,
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
  /** Codex round 11 (finding 2): threaded through from the claim RPC (both
   *  `fn_claim_appointment_reminders` and `fn_claim_reminder_retries` now
   *  return these — see 20260814200000) so the Slack CTA can build a
   *  linkage-aware deep link instead of the dead `/tasks/<id>` route.
   *  Exactly one of the two (or neither, for a personal block) is ever
   *  set — same contract as `tasks.related_property_id`/`tasks.contact_id`
   *  themselves. */
  relatedPropertyId: string | null;
  contactId: string | null;
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
  | { status: "failed"; deliveryId: string; channel: ReminderChannel; error: string }
  | {
      /** Codex round 7 (finding 1): the sweep's own per-delivery deadline
       *  elapsed while the provider call was still in flight — see
       *  `markReminderDeliveryTimedOut` and `resolveTimedOutReminderDelivery`
       *  below. NOT a confirmed failure: completion is genuinely unknown at
       *  this point, so this must never be treated as retryable. */
      status: "timeout_ambiguous";
      deliveryId: string;
      channel: ReminderChannel;
    }
  | {
      /** Codex round 8: distinct from `timeout_ambiguous` above —
       *  `timeout_ambiguous` per the round-7 doc comment is only ever
       *  produced by `withDeliveryDeadline`'s own race (never by a settled
       *  delivery promise). This variant IS returned by a settled delivery
       *  promise (`deliverSms`, when its deadline `signal` fired mid-call —
       *  see `sendRepSmsReminder`'s `aborted_ambiguous` reason) and carries
       *  the exact same "completion unknown, never retryable" guarantee.
       *  `resolveTimedOutReminderDelivery` treats it as a same-status
       *  no-op write (`timeout_ambiguous` -> `timeout_ambiguous`, updated
       *  `last_error` only) rather than transitioning to `failed` — the
       *  bug this round fixes: an abort is NOT proof of non-delivery, so
       *  moving the row to `failed` would make it retry-eligible and risk
       *  a duplicate SMS on top of a send that may have already gone out. */
      status: "aborted_ambiguous";
      deliveryId: string;
      channel: ReminderChannel;
      lastError: string;
    };

/** Every status `markDelivery` (and its callers) can write or fence
 *  against. Deliberately broader than `ClaimedReminderRow.claimedStatus`
 *  ("pending" | "failed", the only two a FRESH claim can hand a worker) —
 *  `timeout_ambiguous` is a status the SWEEP ROUTE itself transitions a row
 *  into and back out of, mid-delivery, never something a claim RPC hands
 *  out. */
type MarkableDeliveryStatus = "pending" | "failed" | "timeout_ambiguous";

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
      status: "sent" | "failed" | "timeout_ambiguous";
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
 *
 * `expectedStatus` (Codex round 7, finding 1) defaults to `row.claimedStatus`
 * — every pre-round-7 call site's original fencing predicate, unchanged.
 * It's overridable so `resolveTimedOutReminderDelivery` below can fence a
 * SECOND transition off `timeout_ambiguous` (the status the sweep route's
 * deadline race left the row in) instead of the row's ORIGINAL pre-claim
 * status, which no longer reflects reality by the time a late provider
 * response comes back.
 *
 * Codex round 11 (finding 1): returns an explicit result instead of
 * `void` — `"applied"` (a row was actually written), `"lease_lost"` (a
 * clean 0-rows result, no error — a different claim now owns this row,
 * still the same benign no-op every caller has always treated it as), or
 * `"write_failed"` (every retry attempt errored). Callers that mark a
 * CONFIRMED provider success ("sent") — or that fence a row into/through
 * `timeout_ambiguous` while its true delivery outcome is still unresolved
 * — must react to `"write_failed"` specifically: leaving the row exactly
 * where it was (still `pending`/`failed`, both retry-claim eligible) is
 * the duplicate-send bug this round fixes. See `repairIntoNonResendState`
 * below for the forced recovery path those callers use.
 */
async function markDelivery(
  supabase: SupabaseClient<Database>,
  row: {
    deliveryId: string;
    attempts: number;
    attemptsAlreadyBumped: boolean;
    claimToken: string;
    claimedStatus: MarkableDeliveryStatus;
  },
  status: "sent" | "failed" | "timeout_ambiguous",
  extra: { providerMessageId?: string | null; lastError?: string | null },
  expectedStatus: MarkableDeliveryStatus = row.claimedStatus,
): Promise<"applied" | "lease_lost" | "write_failed"> {
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
    const { data, error } = await (supabase as unknown as DeliveryUpdateClient)
      .from("task_reminder_deliveries")
      .update(values)
      .eq("id", row.deliveryId)
      .eq("claim_token", row.claimToken)
      .eq("status", expectedStatus)
      .select("id");

    if (!error) {
      // Codex round 11: the row count IS now inspected — "applied" (this
      // write landed) vs "lease_lost" (clean 0-rows, no error — see the
      // doc comment above for why that's still a benign no-op, unchanged
      // from every pre-round-11 caller's behavior).
      return data && data.length > 0 ? "applied" : "lease_lost";
    }

    lastErrorMessage = error.message;
    if (attempt < MARK_DELIVERY_WRITE_ATTEMPTS) {
      await sleep(MARK_DELIVERY_RETRY_BACKOFF_MS * attempt);
    }
  }

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
  return "write_failed";
}

/**
 * Codex round 11 (finding 1): last-resort escalation for a delivery whose
 * bookkeeping write must not be silently left retryable — either a
 * confirmed-sent provider call whose own mark-sent write exhausted
 * `markDelivery`'s retries (`markSentOrRepair` below), or the sweep's
 * initial timeout fence itself failing while the provider call is
 * genuinely still in flight (`markReminderDeliveryTimedOut`). Both leave
 * the row at its stale pre-write status (`pending`/`failed`) if nothing
 * further is done — both are retry-claim eligible, and a retry re-sending
 * on top of a delivery that may already have gone out (or is still
 * in-flight) is a real duplicate.
 *
 * Reuses `timeout_ambiguous` as the non-resend repair state (Codex round
 * 11 decision, documented on the status CHECK constraint's comment,
 * 20260814200000) rather than adding a new status value: it already has
 * every property this needs — excluded from `fn_claim_reminder_retries`'s
 * eligibility BY CONSTRUCTION (its candidates CTE only ever matches
 * `status IN ('failed', 'pending')`), and already gets manual-
 * reconciliation visibility for free via the sweep route's hourly
 * lingering-`timeout_ambiguous` telemetry — no further plumbing needed.
 *
 * First attempt is the SAME fenced write (id + claim_token + the row's
 * `claimedStatus`, i.e. whatever `markDelivery`'s own failed attempts were
 * ALSO fenced against — the row's real DB status, since none of those
 * writes landed) every other transition in this module uses; a row whose
 * lease has since moved to a different owner correctly no-ops there (that
 * owner's own write governs, nothing left for this call to do). Only if
 * the fenced repair write ITSELF errors does this fall back to an
 * UNFENCED update by id alone — deliberately skipping the claim_token/
 * status predicates, because at this point the duplicate-SEND risk of
 * leaving the row retryable outweighs the smaller risk of clobbering an
 * unlikely concurrent legitimate transition. A silent fenced (or
 * unfenced) success reports nothing further — `markDelivery`'s own
 * `write_failed` call above already reported the original failure with
 * the duplicate-risk tag; this function only escalates loudly when the
 * REPAIR itself can't land either.
 */
async function repairIntoNonResendState(
  supabase: SupabaseClient<Database>,
  row: {
    deliveryId: string;
    attempts: number;
    attemptsAlreadyBumped: boolean;
    claimToken: string;
    claimedStatus: MarkableDeliveryStatus;
  },
  lastError: string,
  providerMessageId: string | null = null,
): Promise<void> {
  const attempts = row.attemptsAlreadyBumped ? row.attempts : row.attempts + 1;
  const values = {
    status: "timeout_ambiguous" as const,
    attempts,
    provider_message_id: providerMessageId,
    last_error: lastError,
    sent_at: null,
  };
  const client = supabase as unknown as DeliveryUpdateClient;

  const fenced = await client
    .from("task_reminder_deliveries")
    .update(values)
    .eq("id", row.deliveryId)
    .eq("claim_token", row.claimToken)
    .eq("status", row.claimedStatus)
    .select("id");
  if (!fenced.error) return;

  const unfenced = await client
    .from("task_reminder_deliveries")
    .update(values)
    .eq("id", row.deliveryId)
    .select("id");
  if (!unfenced.error) {
    reportError(
      new Error(
        `repair-into-non-resend fenced write failed (${fenced.error.message}); unfenced fallback applied`,
      ),
      {
        tags: {
          surface: "reminder_delivery_mark",
          duplicate_risk: true,
          repair_unfenced: true,
        },
        extra: { deliveryId: row.deliveryId },
      },
    );
    return;
  }

  reportError(
    new Error(
      `repair-into-non-resend failed on BOTH fenced and unfenced writes: ${unfenced.error.message}`,
    ),
    {
      tags: {
        surface: "reminder_delivery_mark",
        duplicate_risk: true,
        repair_failed: true,
      },
      extra: { deliveryId: row.deliveryId },
    },
  );
}

/**
 * Codex round 11 (finding 1): the shared "mark sent, and if the write
 * can't be confirmed applied, force the row into the non-resend repair
 * state" path used by every channel's provider-success write (bell,
 * slack x2 — reconcile and fresh-send, sms x2 — same, and the late-
 * resolved-success branch of `resolveTimedOutReminderDelivery`). Returns
 * `true` only when `markDelivery` reports `"applied"` or `"lease_lost"` —
 * the two outcomes every pre-round-11 caller already treated as "report
 * sent" — so this is a pure refactor for those two cases and a genuine
 * behavior fix only for `"write_failed"`.
 */
async function markSentOrRepair(
  supabase: SupabaseClient<Database>,
  row: {
    deliveryId: string;
    attempts: number;
    attemptsAlreadyBumped: boolean;
    claimToken: string;
    claimedStatus: MarkableDeliveryStatus;
  },
  providerMessageId: string | null,
  repairContext: string,
): Promise<boolean> {
  const result = await markDelivery(supabase, row, "sent", { providerMessageId });
  if (result === "write_failed") {
    await repairIntoNonResendState(
      supabase,
      row,
      `${repairContext}: mark-sent write failed after retries; duplicate-risk, needs manual reconciliation`,
      providerMessageId,
    );
    return false;
  }
  return true;
}

/**
 * Codex round 6 (finding 2), superseded by round 7 (finding 1): the sweep
 * route (route.ts) races each slack/sms delivery against a deadline derived
 * from the remaining phase budget — a single provider call with no bound
 * could otherwise blow through the phase boundary or the whole 45s sweep
 * budget (the Slack SDK has no default request timeout; Sendillo's HTTP
 * client is likewise unbounded here absent the round-7 AbortSignal, which
 * is only best-effort — see `deliverSms`). When the race times out, the
 * route calls this to fence the row `claimedStatus -> timeout_ambiguous`
 * (NOT `failed`) using the same `claim_token`-scoped write every other
 * outcome uses (`markDelivery`).
 *
 * Round 6 originally marked this a retryable `failed` — but the abandoned
 * provider call is NOT cancelled (true cross-SDK cancellation isn't
 * reliable; see the round-7 plan), so it may still reach Slack/Sendillo
 * after this write lands. A `failed` row is immediately retry-eligible
 * (`fn_claim_reminder_retries`), and a LATE provider success can't persist
 * over it (the fence expects `failed`, not the eventual real outcome) — the
 * retry worker would then re-send on top of a delivery that may already
 * have gone out, a guaranteed duplicate under a slow provider.
 * `timeout_ambiguous` is a non-resend holding state instead: excluded from
 * `fn_claim_reminder_retries`'s eligibility by construction (its candidates
 * CTE only ever matches `status IN ('failed', 'pending')` — see
 * 20260814200000_appointment_reminders.sql), so nothing can pick this row
 * up while its outcome is unknown. `resolveTimedOutReminderDelivery` below
 * is the row's only way out: the route's `after()` continuation awaits the
 * SAME still-running provider promise and fences the row's real resolution
 * (sent, with the provider id; or failed, now safely retryable because the
 * provider definitively did not deliver) off THIS `timeout_ambiguous`
 * status. A continuation that never resolves (process killed, provider
 * call truly hangs) leaves the row here permanently — surfaced by the
 * sweep's hourly lingering-`timeout_ambiguous` telemetry for manual
 * operator reconciliation.
 */
export async function markReminderDeliveryTimedOut(
  supabase: SupabaseClient<Database>,
  row: Pick<
    ClaimedReminderRow,
    "deliveryId" | "attempts" | "attemptsAlreadyBumped" | "claimToken" | "claimedStatus"
  >,
): Promise<void> {
  const result = await markDelivery(supabase, row, "timeout_ambiguous", {
    lastError: "delivery timeout, completion ambiguous",
  });
  if (result === "write_failed") {
    // Codex round 11 (finding 1): if THIS fence can't land, the row is
    // left at its original pending/failed status while the provider call
    // is genuinely still in flight — retry-claim eligible on top of a
    // delivery whose outcome is truly unknown. Force it into the same
    // non-resend holding state by other means (fenced-then-unfenced).
    await repairIntoNonResendState(
      supabase,
      row,
      "sweep deadline fence write failed after retries; delivery completion unresolved, duplicate-risk",
    );
  }
}

/**
 * Codex round 7 (finding 1): resolves a row `markReminderDeliveryTimedOut`
 * previously fenced into `timeout_ambiguous`, once the provider call that
 * was still in flight at the deadline finally settles. Called from the
 * sweep route's `after()` continuation (post-response, so it doesn't hold
 * up the sweep's own HTTP response) with whatever `deliverAppointmentReminder`
 * eventually resolved to for this row.
 *
 * Fenced the same way as every other write here, but against
 * `timeout_ambiguous` specifically (NOT `row`'s original pre-claim
 * `claimedStatus`, which is stale by now) — so if this row's lease was
 * somehow reclaimed a second time in between (a later sweep's retry claim
 * — though it can't, since `timeout_ambiguous` is excluded from that
 * claim's eligibility by construction), this write would correctly no-op
 * rather than clobber a newer owner.
 *
 * - `outcome.status === "sent"`: the provider DID deliver — persist the
 *   real `provider_message_id` and mark sent, exactly as an on-time success
 *   would have.
 * - `outcome.status === "failed"`: the provider definitively did NOT
 *   deliver — the row is now safely retryable (the standard `failed`
 *   state), unlike immediately after the deadline where "did it deliver?"
 *   was still unknown.
 *
 * `outcome.status === "timeout_ambiguous"` never reaches here — that
 * variant is only ever returned BY `withDeliveryDeadline` itself when a
 * race times out; the promise this function awaits is the raw
 * `deliverAppointmentReminder` call, which never produces it.
 */
export async function resolveTimedOutReminderDelivery(
  supabase: SupabaseClient<Database>,
  row: Pick<ClaimedReminderRow, "deliveryId" | "attempts" | "attemptsAlreadyBumped" | "claimToken">,
  outcome: ReminderDeliveryOutcome,
): Promise<void> {
  const scopedRow = { ...row, claimedStatus: "timeout_ambiguous" as const };
  if (outcome.status === "sent") {
    // Codex round 11 (finding 1): the provider DID deliver — if the write
    // recording that can't be confirmed applied, `markSentOrRepair`
    // forces the row into the (already-current, in this branch) non-
    // resend repair state rather than leaving it retryable. See that
    // helper's doc comment for why "write_failed" is the only outcome
    // needing this — "applied"/"lease_lost" behave exactly as before.
    await markSentOrRepair(
      supabase,
      scopedRow,
      outcome.providerMessageId ?? null,
      "late-resolved provider success",
    );
    return;
  }
  if (outcome.status === "failed") {
    await markDelivery(supabase, scopedRow, "failed", { lastError: outcome.error });
    return;
  }
  if (outcome.status === "aborted_ambiguous") {
    // Codex round 8: the deadline abort proves nothing about delivery —
    // leave the row exactly where the timeout race already fenced it
    // (`timeout_ambiguous`), same status in and out, and record the abort
    // reason for operator visibility only. Never transitions to `failed`:
    // that would make the row retry-eligible and risk a duplicate SMS on
    // top of a send that may have already reached Sendillo.
    await markDelivery(supabase, scopedRow, "timeout_ambiguous", {
      lastError: "aborted; delivery ambiguous",
    });
    return;
  }
  // Unreachable per the doc comment above — defense in depth only.
  await markDelivery(supabase, scopedRow, "failed", {
    lastError: "unexpected timeout_ambiguous outcome from a settled delivery promise",
  });
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
    const confirmed = await markSentOrRepair(supabase, row, null, "bell notification created");
    if (!confirmed) {
      return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: "bell" };
    }
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
    const confirmed = await markSentOrRepair(
      supabase,
      row,
      row.providerMessageId,
      "slack reconcile (prior attempt already reached Slack)",
    );
    if (!confirmed) {
      return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: "slack" };
    }
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
    // Codex round 11 (finding 2): linkage-aware CTA — property-linked ->
    // /leads/<id>, contact-only -> /messages?thread=<contactId>, personal
    // block (neither) -> /dashboard. `buildTaskDeepLink`'s `/tasks/<id>`
    // (the prior deep link here) 404s: that route has no page.tsx.
    deepLink: buildAppointmentDeepLink(row.relatedPropertyId, row.contactId),
  });
  if (result.sent) {
    const confirmed = await markSentOrRepair(supabase, row, result.messageTs, "slack send");
    if (!confirmed) {
      return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: "slack" };
    }
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
  opts: { signal?: AbortSignal } = {},
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
    const confirmed = await markSentOrRepair(
      supabase,
      row,
      row.providerMessageId,
      "sms reconcile (prior attempt already reached Sendillo)",
    );
    if (!confirmed) {
      return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: "sms" };
    }
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
  //
  // Codex round 7 (finding 1, item 5): `opts.signal` is the sweep route's
  // per-delivery deadline (see `withDeliveryDeadline`) — passed through so
  // Sendillo's underlying fetch can be torn down proactively instead of
  // running to its own 10s internal timeout after this row has already
  // moved to `timeout_ambiguous`. This is best-effort resource cleanup
  // ONLY: whether an abort fired before or after Sendillo actually received
  // the request isn't cleanly detectable through the standard fetch API
  // (see `SendilloMessagingProvider.sendSms`'s doc comment), so an abort
  // still surfaces as an ordinary provider error here and is reconciled
  // through the SAME ambiguous-until-resolved path as any other late
  // outcome — never auto-marked "definitely not sent".
  const result = await sendRepSmsReminder({ to: prefs.reminderPhone, body, signal: opts.signal });
  if (result.ok) {
    const confirmed = await markSentOrRepair(supabase, row, result.externalId, "sms send");
    if (!confirmed) {
      return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: "sms" };
    }
    return {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "sms",
      providerMessageId: result.externalId,
    };
  }
  if (result.reason === "aborted_ambiguous") {
    // Codex round 8: an abort is NOT proof of non-delivery — must not be
    // marked `failed` (that was the bug: a deadline abort mid-Sendillo-call
    // used to fall through to the generic markDelivery-failed write below,
    // which — via the sweep's `after()` continuation replaying this same
    // outcome through `resolveTimedOutReminderDelivery` — transitioned the
    // row `timeout_ambiguous -> failed` and made it retry-eligible despite
    // completion being genuinely unknown).
    //
    // Codex round 10 (finding 2): round 8's comment here used to say "no
    // markDelivery call here" on the theory that only
    // `resolveTimedOutReminderDelivery` (reached via `withDeliveryDeadline`'s
    // OWN timeout race) ever needs to fence this row. That's true when the
    // SWEEP's deadline is what fired — but `sendRepSmsReminder` can also
    // resolve `aborted_ambiguous` because SENDILLO'S OWN internal timeout
    // won the race (see sendillo.ts's `DEFAULT_SEND_TIMEOUT_MS`), which can
    // settle BEFORE the sweep's own deadline ever elapses. In that direct
    // race, this function's return value goes straight back through
    // `withDeliveryDeadline`'s `Promise.race` (the `result !== TIMED_OUT`
    // branch) without `markReminderDeliveryTimedOut` ever running — the row
    // is left sitting at its original `claimedStatus` (`pending`/`failed`),
    // still eligible for `fn_claim_reminder_retries` to reclaim and re-send
    // on top of a delivery whose outcome is genuinely unknown. Fence it
    // HERE, unconditionally: if the sweep's own deadline race already won
    // and fenced the row (the OTHER scenario), this write's
    // `expectedStatus` (`row.claimedStatus`, the now-stale pre-claim value)
    // simply matches zero rows and is the same benign "lease lost" no-op
    // `markDelivery` already treats every other 0-row result as — the real
    // fence in that scenario is still `resolveTimedOutReminderDelivery`'s.
    await markDelivery(supabase, row, "timeout_ambiguous", {
      lastError: result.message,
    });
    return {
      status: "aborted_ambiguous",
      deliveryId: row.deliveryId,
      channel: "sms",
      lastError: result.message,
    };
  }
  // Codex round 10 (finding 4): `result.reason === "not_sent"` (the deadline
  // signal was already aborted before Sendillo's fetch ever went out) lands
  // here too — deliberately. Unlike `aborted_ambiguous` above, it's
  // PROVABLY non-delivery (see `RepSmsSendResult`'s `not_sent` variant in
  // rep-sms.ts), so the ordinary retryable `failed` write below is the
  // correct, honest outcome — no ambiguous-holding-state fencing needed.
  await markDelivery(supabase, row, "failed", { lastError: result.message });
  return { status: "failed", deliveryId: row.deliveryId, channel: "sms", error: result.message };
}

/**
 * Delivers one claimed reminder row on its channel and marks the delivery
 * row sent/failed. Never throws across the boundary — an unexpected
 * exception from any channel's provider call is caught, the delivery
 * marked failed, and a `failed` outcome returned, so one row's crash
 * never aborts the sweep loop calling this.
 *
 * `opts.signal` (Codex round 7, finding 1, item 5) is only forwarded to the
 * sms channel — Sendillo's client is fetch-based, so it's the only provider
 * call here that can be proactively cancelled. Bell is a direct DB write
 * (no provider call to cancel); Slack's SDK has no signal plumbing in
 * scope for this fix.
 */
export async function deliverAppointmentReminder(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
  opts: { signal?: AbortSignal } = {},
): Promise<ReminderDeliveryOutcome> {
  try {
    switch (row.channel) {
      case "bell":
        return await deliverBell(supabase, row);
      case "slack":
        return await deliverSlack(supabase, row);
      case "sms":
        return await deliverSms(supabase, row, opts);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markDelivery(supabase, row, "failed", { lastError: message });
    return { status: "failed", deliveryId: row.deliveryId, channel: row.channel, error: message };
  }
}
