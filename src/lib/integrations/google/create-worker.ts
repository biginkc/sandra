import type { SupabaseClient } from "@supabase/supabase-js";
import type { calendar_v3 } from "googleapis";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import type { Database } from "@/lib/supabase/types";
import {
  buildCalendarClient,
  isGoogleConflict,
  isGoogleNotFound,
  type CalendarClient,
} from "./dispatch";

/**
 * Durable calendar-mutation ledger consumer. PR 2 introduced this as a
 * `create`-only pull-forward; PR 3 (migration 20260814210000) widens the
 * claim RPC to `operation IN (create, reschedule, reassign, cancel)` and
 * this file gains one handler per operation, dispatched by
 * `processClaimedCalendarMutation`. Full plan: reactive-puzzling-crane.md
 * v9, "Calendar lifecycle = durable mutation ledger" (PR 3 section) + R7-2
 * (terminal behavior for optional Calendar) + R6-2 (provider-side
 * idempotency via client-supplied event id).
 *
 * Every operation's provider step reads the LEDGER row for lineage (which
 * event, under whose account) — never a live re-read of
 * `tasks.google_calendar_event_id` — per the plan: "Provider step reads the
 * ledger, never infers lineage from task rows." The lifecycle RPCs
 * (fn_cancel_appointment / fn_reschedule_appointment /
 * fn_reassign_appointment) capture that lineage into the ledger row at
 * write time; this worker only ever reads it back.
 */

/** Row shape returned by `fn_claim_calendar_mutations` (PR 3 rename+widen
 *  of `fn_claim_calendar_creations`) — not in the generated
 *  Database["public"]["Functions"] map (same rationale as the booking
 *  RPCs: that regeneration belongs to whichever PR promotes this into the
 *  generated types). */
export type ClaimedCalendarMutationRow = {
  ledger_id: string;
  org_id: string;
  calendar_chain_id: string;
  operation: "create" | "reschedule" | "reassign" | "cancel";
  /** Round 6: the claim RPC also admits 'provider_done' rows (provider call
   *  already succeeded, finalize crashed before completing) — never
   *  anything else. */
  phase: "pending" | "provider_done";
  source_task_id: string;
  /** Reschedule only — the successor row created by fn_reschedule_appointment. */
  target_task_id: string | null;
  old_assignee_id: string;
  /** Reassign only. */
  new_assignee_id: string | null;
  /** The Google event id this operation acts on: deletes it (cancel),
   *  updates it (reschedule), or deletes it under the OLD account
   *  (reassign). NULL means no event ever existed for this appointment. */
  event_id: string | null;
  new_event_id: string | null;
  client_event_id: string | null;
  result_reason: string | null;
  expected_generation: number;
  attempts: number;
  /** Round 7 fencing token: minted fresh by the claim RPC on every
   *  claim/reclaim. Every write this worker makes to the row is scoped by
   *  this value — see the module-level fencing comment below. */
  claim_token: string;
  source_due_at: string;
  source_end_at: string;
  source_title: string;
  source_assignee_id: string;
  target_due_at: string | null;
  target_end_at: string | null;
  target_title: string | null;
  target_assignee_id: string | null;
};

/** Back-compat alias: PR 2 code and tests referred to this row shape as
 *  "creation" specifically, before the claim widened to every operation. */
export type ClaimedCalendarCreationRow = ClaimedCalendarMutationRow;

export type CalendarMutationOutcome =
  | { status: "created"; ledgerId: string; eventId: string }
  | { status: "reconciled_409"; ledgerId: string; eventId: string }
  | { status: "reassigned"; ledgerId: string; eventId: string }
  | { status: "updated"; ledgerId: string; eventId: string }
  | { status: "deleted"; ledgerId: string }
  /** cancel/reschedule with no Google event to act on (booking was never
   *  connected to Calendar, or the original create finalized as a no-op) —
   *  an immediate finalize, no provider call made. */
  | { status: "no_event"; ledgerId: string }
  | { status: "pref_disabled"; ledgerId: string }
  | { status: "no_token"; ledgerId: string }
  /** Codex round 1 fix: a KNOWN Google event exists for this cancel/
   *  reschedule/reassign (claimed.event_id, or — for reassign — the new
   *  assignee side) and the token/pref needed to act on it is missing
   *  RIGHT NOW. Unlike `no_token`/`pref_disabled` (which mean "no event
   *  ever existed, nothing to reconcile"), finalizing this as success
   *  would leave a real Google event silently stale (the local task's
   *  outcome never happened, or happened on the wrong account). Retryable
   *  — the token may return — with `result_reason` set to the honest
   *  'no_token_stale_event' / 'pref_disabled_stale_event' so
   *  `fn_expire_exhausted_calendar_mutations` routes exhaustion to
   *  `needs_repair` (keeps the chain-serialization slot held) instead of
   *  the ordinary `failed` (which would free it over a still-unreconciled
   *  event). */
  | { status: "stale_event_needs_token"; ledgerId: string; error: string }
  | { status: "retryable_error"; ledgerId: string; error: string }
  | { status: "permanent_error"; ledgerId: string; error: string }
  /** Provider succeeded and `provider_done` was persisted, but the
   *  finalize CAS lost — the task's `calendar_generation` moved out from
   *  under this mutation between claim and finalize (a newer lifecycle
   *  mutation won the race). Left at `provider_done`; never resurrected
   *  here — the plan's compare-and-set contract. */
  | { status: "finalize_conflict"; ledgerId: string; eventId: string; taskId: string }
  /** Round 7 fencing: this worker's claim_token (or expected phase) no
   *  longer matched the row at write time — another worker already
   *  reclaimed the expired lease and is (or already has) processed it.
   *  Not an error: the row is abandoned silently, ownership belongs to
   *  whoever holds the current token. */
  | { status: "lease_lost"; ledgerId: string };

/** Back-compat alias — PR 2's create-only outcome union. */
export type CalendarCreationOutcome = CalendarMutationOutcome;

type Supabase = SupabaseClient<Database>;

/** task_calendar_mutations.next_attempt_at / claim_token are added by PR 2's
 *  migration (20260814170000) and, per PR 2/PR 3's scope, must not be
 *  added to the generated Database["public"]["Tables"] map yet — same
 *  local-cast pattern used for the claim RPC row shape above and the
 *  booking RPCs' call sites.
 *
 *  Round 7: every write is chained through `.eq("id", ...).eq("claim_token",
 *  ...).eq("phase", ...).select("id")` so the caller can see exactly how
 *  many rows matched (0 or 1) rather than trusting a bare `{error: null}`
 *  — a 0-row match is the "lost the lease" signal, not a database error.
 */
type LedgerMutationRow = { id: string };
type TokenedLedgerUpdateBuilder = {
  eq(column: "id" | "claim_token" | "phase", value: string): TokenedLedgerUpdateBuilder;
  select(columns: "id"): PromiseLike<{
    data: LedgerMutationRow[] | null;
    error: { message: string } | null;
  }>;
};
type LedgerLeaseUpdateClient = {
  from(table: "task_calendar_mutations"): {
    update(values: {
      phase?: string;
      new_event_id?: string;
      result_reason?: string;
      last_error?: string;
      next_attempt_at?: string;
      updated_at?: string;
    }): TokenedLedgerUpdateBuilder;
  };
};

const nowIso = () => new Date().toISOString();

/** Matches the claim RPC's flat 2-minute lease (migration 20260814170000).
 *  Worker-side backoff scales it by `attempts` so repeated failures push
 *  the row further out each time instead of retrying at a fixed interval.
 *  Also reused as the lease-renewal window (see `renewLease` below). */
const RETRY_BACKOFF_UNIT_MS = 2 * 60 * 1000;

/**
 * Every write to `task_calendar_mutations` after the claim goes through
 * this: scoped by the row id, this worker's `claim_token`, AND the exact
 * phase this worker expects to find the row in. A 0-row result means the
 * lease was lost — reclaimed by another worker (different token) or the
 * row already moved past the expected phase by some other path — and the
 * caller must abandon the row silently rather than treat it as failure.
 * No transition is ever called with `expectedPhase: "finalized"`, so a
 * finalized row structurally can never be written by any transition here.
 */
async function applyLedgerTransition(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  expectedPhase: "pending" | "provider_done",
  values: {
    phase?: string;
    new_event_id?: string;
    result_reason?: string;
    last_error?: string;
    next_attempt_at?: string;
    updated_at?: string;
  },
): Promise<{ applied: boolean; error?: string }> {
  const { data, error } = await (supabase as unknown as LedgerLeaseUpdateClient)
    .from("task_calendar_mutations")
    .update(values)
    .eq("id", ledgerId)
    .eq("claim_token", claimToken)
    .eq("phase", expectedPhase)
    .select("id");
  if (error) return { applied: false, error: error.message };
  return { applied: (data?.length ?? 0) > 0 };
}

/**
 * Renew the claim lease immediately after a (potentially long) Google API
 * call returns, before any other DB write — closes the window where a
 * slow provider call outlives the 2-minute lease and a concurrent sweep
 * reclaims the row while this worker is still mid-flight. Still
 * token-conditioned: if the lease was already reclaimed by the time this
 * runs, this affects zero rows and the caller abandons the row instead of
 * writing over the new owner's writes.
 */
async function renewLease(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  expectedPhase: "pending" | "provider_done",
): Promise<{ applied: boolean; error?: string }> {
  return applyLedgerTransition(supabase, ledgerId, claimToken, expectedPhase, {
    next_attempt_at: new Date(Date.now() + RETRY_BACKOFF_UNIT_MS).toISOString(),
    updated_at: nowIso(),
  });
}

/**
 * Dispatch a claimed row to its operation-specific handler. Every handler
 * shares the same never-throw contract (see `processClaimedCalendarCreation`'s
 * doc comment) — this dispatcher adds no additional try/catch because each
 * handler already owns its own top-level guard.
 */
export async function processClaimedCalendarMutation(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  switch (claimed.operation) {
    case "create":
      return processClaimedCalendarCreation(supabase, claimed);
    case "cancel":
      return processClaimedCancel(supabase, claimed);
    case "reschedule":
      return processClaimedReschedule(supabase, claimed);
    case "reassign":
      return processClaimedReassign(supabase, claimed);
    default: {
      // Exhaustiveness guard — the claim RPC's operation CHECK constraint
      // and this union should always agree; if they ever drift, fail this
      // one row loudly instead of silently no-op'ing it.
      const message = `unknown calendar mutation operation: ${String((claimed as { operation: unknown }).operation)}`;
      reportError(new Error(message), {
        tags: { surface: "calendar_mutation_worker_unknown_operation" },
        extra: { ledgerId: claimed.ledger_id },
      });
      return { status: "permanent_error", ledgerId: claimed.ledger_id, error: message };
    }
  }
}

/**
 * Process one claimed `create` row, already attempts-bumped and
 * lease-stamped (with a fresh `claim_token`, round 7) by the claim RPC.
 * Never throws — every branch is a typed outcome; unexpected errors are
 * caught, reported, and treated as retryable (left in place with
 * `last_error` and a backed-off `next_attempt_at` set) rather than
 * silently swallowed or crashing the sweep.
 *
 * `phase='provider_done'` (round 6) means a prior attempt already created
 * the Google event but crashed before the task CAS / ledger finalize
 * completed — that path resumes without ever calling Google again.
 */
export async function processClaimedCalendarCreation(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;
  if (claimed.phase === "provider_done") {
    // Same never-throw boundary as the 'pending' path below: a
    // transport-level rejection anywhere in the resume chain (lease
    // renewal, the task CAS, or the ledger finalize write) must not escape
    // this function — it would otherwise abort the whole sweep loop
    // (route.ts claims/processes one row at a time) with no error/backoff
    // recorded on this row, and can push an otherwise-recoverable
    // provider_done row toward the needs_repair exhaustion path instead of
    // retrying normally. The row is 'provider_done' throughout the resume
    // path, so the recorded expectedPhase here is 'provider_done', not
    // 'pending' — matching the phase the token-fenced write must target.
    try {
      return await resumeProviderDoneCreation(supabase, claimed);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError(e, {
        tags: { surface: "calendar_creation_worker_provider_done_resume" },
        extra: { ledgerId, sourceTaskId: claimed.source_task_id },
      });
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
        claimed.attempts,
      ).catch(() => ({ applied: false, lost: false }));
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: message };
    }
  }
  try {
    const prefs = await loadIntegrationPrefs(supabase, claimed.source_assignee_id);
    if (!prefs.calendarEnabled) {
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "pref_disabled");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "pref_disabled", ledgerId };
    }

    const token = await getDecryptedToken({
      userId: claimed.source_assignee_id,
      provider: "google",
      tokenType: "user",
    });
    if (!token) {
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "no_token");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "no_token", ledgerId };
    }

    if (!claimed.client_event_id) {
      // Structurally shouldn't happen — fn_book_appointment sets it in the
      // same transaction as the ledger row — but fail closed rather than
      // calling Google with an undefined id and creating an
      // unreconcilable event on retry.
      const message = "ledger row has no client_event_id";
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.source_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    let eventId: string;
    let reconciled = false;
    try {
      const response = await calendar.events.insert({
        calendarId: "primary",
        requestBody: buildEvent(claimed.client_event_id, claimed.source_title, claimed.source_due_at, claimed.source_end_at),
      });
      if (!response.data.id) throw new Error("Google returned no event id");
      eventId = response.data.id;
    } catch (e) {
      if (isGoogleConflict(e)) {
        // The client-supplied id already exists — either a genuine retry
        // after a crash between provider success and phase-advance, or a
        // (should-be-impossible) id collision. Either way, reconciling by
        // fetching that exact id and treating it as this row's event is
        // correct: R6-2's whole point is that this id is unique to this
        // ledger row.
        try {
          const existing = await calendar.events.get({
            calendarId: "primary",
            eventId: claimed.client_event_id,
          });
          if (!existing.data.id) {
            throw new Error("409-reconcile lookup returned no event id");
          }
          eventId = existing.data.id;
          reconciled = true;
        } catch (reconcileError) {
          return await handleProviderFailure(
            supabase,
            ledgerId,
            claimToken,
            "pending",
            reconcileError,
            claimed.attempts,
          );
        }
      } else {
        return await handleProviderFailure(
          supabase,
          ledgerId,
          claimToken,
          "pending",
          e,
          claimed.attempts,
        );
      }
    }

    // Round 7: renew the lease right after the (potentially long) Google
    // call returns, before writing provider_done — see `renewLease`.
    const renewed = await renewLease(supabase, ledgerId, claimToken, "pending");
    if (renewed.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        renewed.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: renewed.error };
    }
    if (!renewed.applied) return { status: "lease_lost", ledgerId };

    // result_reason is written here too (not just at finalize) so a crash
    // between this write and the finalize below leaves a provider_done row
    // that a later resume (resumeProviderDoneCreation) can read back to
    // know whether the original attempt was a fresh create or a 409
    // reconcile, instead of guessing 'event_created' by default.
    const providerDone = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
      phase: "provider_done",
      new_event_id: eventId,
      result_reason: reconciled ? "reconciled_409" : "event_created",
      updated_at: nowIso(),
    });
    if (providerDone.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        providerDone.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: providerDone.error };
    }
    if (!providerDone.applied) return { status: "lease_lost", ledgerId };

    return await finalizeCreation(
      supabase,
      ledgerId,
      claimToken,
      claimed.source_task_id,
      claimed.expected_generation,
      eventId,
      reconciled,
      claimed.attempts,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "calendar_creation_worker" },
      extra: { ledgerId, sourceTaskId: claimed.source_task_id },
    });
    // Everything in this try block up to the provider_done write either
    // hasn't run yet or already returned a typed outcome without throwing
    // (finalizeCreation never throws) — so an exception reaching here
    // always means the row is still 'pending'.
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "pending",
      message,
      claimed.attempts,
    ).catch(() => ({ applied: false, lost: false }));
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: message };
  }
}

/**
 * Resume a claimed row already at phase='provider_done' (round 6): a
 * prior attempt's Google call succeeded but the process crashed before
 * the task CAS / ledger finalize completed. Never calls Google except in
 * the (structurally-shouldn't-happen) fallback where new_event_id itself
 * is missing — the normal case goes straight to finalizeCreation reusing
 * the recorded event id and result_reason. The row is 'provider_done'
 * throughout this whole function, so every transition below expects that
 * phase.
 */
async function resumeProviderDoneCreation(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;
  let eventId = claimed.new_event_id;
  let reconciled = claimed.result_reason === "reconciled_409";

  if (!eventId) {
    if (!claimed.client_event_id) {
      const message =
        "provider_done ledger row has no new_event_id or client_event_id to reconcile";
      const r = await markPermanentFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    const token = await getDecryptedToken({
      userId: claimed.source_assignee_id,
      provider: "google",
      tokenType: "user",
    }).catch((e) => {
      reportError(e, {
        tags: { surface: "calendar_creation_worker_provider_done_resume" },
        extra: { ledgerId },
      });
      return null;
    });
    if (!token) {
      const message = "provider_done row missing new_event_id and has no token to reconcile it";
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.source_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await markPermanentFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    try {
      const existing = await calendar.events.get({
        calendarId: "primary",
        eventId: claimed.client_event_id,
      });
      if (!existing.data.id) {
        throw new Error("provider_done reconcile lookup returned no event id");
      }
      eventId = existing.data.id;
      reconciled = true;
    } catch (e) {
      return await handleProviderFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        e,
        claimed.attempts,
      );
    }

    // Round 7: renew before writing new_event_id, same rationale as the
    // fresh-create path — the events.get call above can be slow too.
    const renewed = await renewLease(supabase, ledgerId, claimToken, "provider_done");
    if (renewed.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        renewed.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: renewed.error };
    }
    if (!renewed.applied) return { status: "lease_lost", ledgerId };

    const newEventId = await applyLedgerTransition(supabase, ledgerId, claimToken, "provider_done", {
      new_event_id: eventId,
      result_reason: "reconciled_409",
      updated_at: nowIso(),
    });
    if (newEventId.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        newEventId.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: newEventId.error };
    }
    if (!newEventId.applied) return { status: "lease_lost", ledgerId };
  }

  return finalizeCreation(
    supabase,
    ledgerId,
    claimToken,
    claimed.source_task_id,
    claimed.expected_generation,
    eventId,
    reconciled,
    claimed.attempts,
  );
}

/**
 * Task google_calendar_event_id CAS + ledger finalize — shared by the
 * fresh-create path (after a successful Google call) and the
 * provider_done resume path. Also reused by `finalizeReassign` (the
 * create-under-new-assignee half of a reassign is the same
 * CAS-onto-source-task shape). The task CAS itself is unrelated to the
 * claim_token fence (it's scoped by `calendar_generation`, a different
 * concurrency axis entirely — the lifecycle RPCs' generation bump, not
 * competing workers); only the ledger finalize write below is
 * token-conditioned. Idempotent by construction: a 0-row finalize result
 * because the row was already finalized by a concurrent resume looks
 * identical to a lost lease here (both are "someone else already handled
 * this"), so it's reported as `lease_lost` rather than an error — the
 * caller of finalizeCreation never mistakes this for a real failure.
 */
async function finalizeCreation(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  sourceTaskId: string,
  expectedGeneration: number,
  eventId: string,
  reconciled: boolean,
  attempts: number,
): Promise<CalendarMutationOutcome> {
  // Finalize is compare-and-set on the task's current calendar_generation
  // (R6-2/R7-2 protocol) — a delayed retry (or a lifecycle RPC that moved
  // generation) can never resurrect/attach an event out from under a newer
  // mutation.
  const { data: taskUpdated, error: taskUpdateError } = await supabase
    .from("tasks")
    .update({ google_calendar_event_id: eventId })
    .eq("id", sourceTaskId)
    .eq("calendar_generation", expectedGeneration)
    .select("id")
    .maybeSingle();
  if (taskUpdateError) {
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "provider_done",
      taskUpdateError.message,
      attempts,
    );
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: taskUpdateError.message };
  }
  if (!taskUpdated) {
    return { status: "finalize_conflict", ledgerId, eventId, taskId: sourceTaskId };
  }

  const finalized = await applyLedgerTransition(supabase, ledgerId, claimToken, "provider_done", {
    phase: "finalized",
    result_reason: reconciled ? "reconciled_409" : "event_created",
    updated_at: nowIso(),
  });
  if (finalized.error) {
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "provider_done",
      finalized.error,
      attempts,
    );
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: finalized.error };
  }
  if (!finalized.applied) return { status: "lease_lost", ledgerId };

  return reconciled
    ? { status: "reconciled_409", ledgerId, eventId }
    : { status: "created", ledgerId, eventId };
}

async function handleProviderFailure(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  expectedPhase: "pending" | "provider_done",
  error: unknown,
  attempts: number,
): Promise<CalendarMutationOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  if (classifyGoogleFailure(error) === "permanent") {
    const r = await markPermanentFailure(supabase, ledgerId, claimToken, expectedPhase, message);
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "permanent_error", ledgerId, error: message };
  }
  // Fail closed toward "retryable" for anything not positively identified
  // as permanent — an unrecognized error shape left in place (attempts
  // already bumped, next_attempt_at backed off) is safer than silently
  // terminal-failing a transient blip. Exhaustion (attempts>=5) is what
  // eventually terminalizes a row that never actually recovers.
  const r = await markRetryableFailure(
    supabase,
    ledgerId,
    claimToken,
    expectedPhase,
    message,
    attempts,
  );
  if (r.lost) return { status: "lease_lost", ledgerId };
  return { status: "retryable_error", ledgerId, error: message };
}

function buildEvent(
  clientEventId: string | null,
  title: string,
  dueAt: string,
  endAt: string,
): calendar_v3.Schema$Event {
  return {
    id: clientEventId ?? undefined,
    summary: title,
    start: { dateTime: dueAt },
    end: { dateTime: endAt },
  };
}

/** pref_disabled / no_token: an immediate no-op finalize — no event was
 *  ever created, so there's nothing to reconcile. Releases the chain's
 *  serialization slot instantly so booking without Google connected never
 *  blocks a later lifecycle mutation. Always called with the row still at
 *  'pending'. */
async function finalizeNoEvent(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  reason: "pref_disabled" | "no_token" | "no_event",
): Promise<{ lost: boolean }> {
  const result = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
    phase: "finalized",
    result_reason: reason,
    updated_at: nowIso(),
  });
  if (result.error) {
    reportError(new Error(result.error), {
      tags: { surface: "calendar_creation_worker_finalize_noop" },
      extra: { ledgerId, reason },
    });
    return { lost: false };
  }
  return { lost: !result.applied };
}

/**
 * Round 7: takes `expectedPhase` explicitly rather than guessing — this is
 * called from both the fresh-create ('pending') path and the
 * provider_done resume path, and each call site knows exactly which phase
 * the row is in at that point (the fencing WHERE clause needs the exact
 * value, not a blanket omission). A 0-row result (lease already lost,
 * including the finalized-is-never-a-valid-expectedPhase case) is
 * reported via `lost`, not as an error — this write is bookkeeping, not
 * the underlying Google failure the caller already knows about.
 */
async function markPermanentFailure(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  expectedPhase: "pending" | "provider_done",
  message: string,
): Promise<{ lost: boolean }> {
  const result = await applyLedgerTransition(supabase, ledgerId, claimToken, expectedPhase, {
    phase: "failed",
    result_reason: "auth_permanent",
    last_error: message,
    updated_at: nowIso(),
  });
  if (result.error) {
    reportError(new Error(result.error), {
      tags: { surface: "calendar_creation_worker_permanent_fail" },
      extra: { ledgerId },
    });
    return { lost: false };
  }
  return { lost: !result.applied };
}

async function markRetryableFailure(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  expectedPhase: "pending" | "provider_done",
  message: string,
  attempts: number,
): Promise<{ applied: boolean; lost: boolean }> {
  // Phase intentionally left as-is ('pending' or 'provider_done') — the
  // claim RPC already bumped attempts and set a flat 2-minute lease; this
  // explicitly pushes next_attempt_at out further, scaled by attempts, so
  // repeated failures back off instead of retrying at that same fixed
  // interval every sweep. The exhaustion cap (attempts < 5 to reclaim,
  // fn_expire_exhausted_calendar_mutations to terminalize) is what
  // eventually stops a permanently-broken row from being reclaimed
  // forever — not a phase transition here.
  const nextAttemptAt = new Date(Date.now() + attempts * RETRY_BACKOFF_UNIT_MS).toISOString();
  const result = await applyLedgerTransition(supabase, ledgerId, claimToken, expectedPhase, {
    last_error: message,
    next_attempt_at: nextAttemptAt,
    updated_at: nowIso(),
  });
  if (result.error) {
    reportError(new Error(result.error), {
      tags: { surface: "calendar_creation_worker_retryable_fail" },
      extra: { ledgerId },
    });
    return { applied: false, lost: false };
  }
  return { applied: result.applied, lost: !result.applied };
}

/**
 * Codex round 1 fix: for cancel/reschedule/reassign where a Google event is
 * KNOWN to exist (or, for reassign, is being created on the new assignee's
 * side of an event that DID exist under the old one) and the token/pref
 * needed to act on it is currently missing, this is the honest outcome —
 * NOT `finalizeNoEvent`, which would mark the ledger `finalized` (success)
 * over a real, un-reconciled Google event. Same backoff formula as
 * `markRetryableFailure` (attempts * 2min), phase left as-is (still
 * 'pending' — no provider call was made), but `result_reason` is set to the
 * honest reason NOW rather than left null, so
 * `fn_expire_exhausted_calendar_mutations` can route exhaustion of THIS row
 * to `needs_repair` (chain slot held) instead of the ordinary `failed`
 * (chain slot freed over a still-stale event) — see that function's CASE
 * in 20260814210000.
 */
async function markStaleEventRetryable(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  resultReason: "no_token_stale_event" | "pref_disabled_stale_event",
  message: string,
  attempts: number,
): Promise<{ lost: boolean }> {
  const nextAttemptAt = new Date(Date.now() + attempts * RETRY_BACKOFF_UNIT_MS).toISOString();
  const result = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
    result_reason: resultReason,
    last_error: message,
    next_attempt_at: nextAttemptAt,
    updated_at: nowIso(),
  });
  if (result.error) {
    reportError(new Error(result.error), {
      tags: { surface: "calendar_worker_stale_event_retryable" },
      extra: { ledgerId, resultReason },
    });
    return { lost: false };
  }
  return { lost: !result.applied };
}

// ----------------------------------------------------------------------------
// cancel
// ----------------------------------------------------------------------------

/**
 * Deletes the ledger-recorded event (404 = idempotent success — the plan's
 * explicit contract) then clears the task's google_calendar_event_id under
 * generation CAS. `phase='provider_done'` on entry means the delete already
 * happened and only the finalize step needs to (re)run.
 */
async function processClaimedCancel(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;

  if (claimed.phase === "provider_done") {
    try {
      return await finalizeCancel(
        supabase,
        ledgerId,
        claimToken,
        claimed.source_task_id,
        claimed.expected_generation,
        claimed.result_reason ?? "event_deleted",
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError(e, {
        tags: { surface: "calendar_cancel_worker_resume" },
        extra: { ledgerId, sourceTaskId: claimed.source_task_id },
      });
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
        claimed.attempts,
      ).catch(() => ({ applied: false, lost: false }));
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: message };
    }
  }

  try {
    if (!claimed.event_id) {
      // No event was ever created for this appointment (never connected,
      // or the original create finalized pref_disabled/no_token) —
      // nothing to delete. Immediate finalize, same idiom as create's
      // finalizeNoEvent.
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "no_event");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "no_event", ledgerId };
    }

    const token = await getDecryptedToken({
      userId: claimed.old_assignee_id,
      provider: "google",
      tokenType: "user",
    });
    if (!token) {
      // Codex round 1 fix: claimed.event_id EXISTS at this point (the
      // !claimed.event_id branch above already returned) — a Google event
      // is known to still be there. Finalizing this as success (the old
      // no-op posture) would leave that event silently un-deleted forever
      // with the ledger claiming the operation is done. Retryable instead
      // — the assignee's token may return — with the honest result_reason
      // so exhaustion routes to needs_repair, not failed.
      const message = "no token for old assignee; event may still exist and be stale";
      const r = await markStaleEventRetryable(
        supabase,
        ledgerId,
        claimToken,
        "no_token_stale_event",
        message,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "stale_event_needs_token", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.old_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    try {
      await calendar.events.delete({ calendarId: "primary", eventId: claimed.event_id });
    } catch (e) {
      if (!isGoogleNotFound(e)) {
        return await handleProviderFailure(
          supabase,
          ledgerId,
          claimToken,
          "pending",
          e,
          claimed.attempts,
        );
      }
      // 404 = already gone = idempotent success (plan's explicit contract) — fall through.
    }

    const renewed = await renewLease(supabase, ledgerId, claimToken, "pending");
    if (renewed.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        renewed.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: renewed.error };
    }
    if (!renewed.applied) return { status: "lease_lost", ledgerId };

    const providerDone = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
      phase: "provider_done",
      result_reason: "event_deleted",
      updated_at: nowIso(),
    });
    if (providerDone.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        providerDone.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: providerDone.error };
    }
    if (!providerDone.applied) return { status: "lease_lost", ledgerId };

    return await finalizeCancel(
      supabase,
      ledgerId,
      claimToken,
      claimed.source_task_id,
      claimed.expected_generation,
      "event_deleted",
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "calendar_cancel_worker" },
      extra: { ledgerId, sourceTaskId: claimed.source_task_id },
    });
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "pending",
      message,
      claimed.attempts,
    ).catch(() => ({ applied: false, lost: false }));
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: message };
  }
}

/** Best-effort CAS-clear of the (now cancelled) task's
 *  google_calendar_event_id, then the ledger finalize write. The CAS
 *  clearing a stale pointer is a courtesy, not a correctness requirement —
 *  cancel is terminal and nothing reads that column meaningfully on a
 *  cancelled appointment — so a lost CAS here is logged but never blocks
 *  the finalize itself. */
async function finalizeCancel(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  sourceTaskId: string,
  expectedGeneration: number,
  resultReason: string,
): Promise<CalendarMutationOutcome> {
  if (resultReason === "event_deleted") {
    const { error: clearError } = await supabase
      .from("tasks")
      .update({ google_calendar_event_id: null })
      .eq("id", sourceTaskId)
      .eq("calendar_generation", expectedGeneration);
    if (clearError) {
      reportError(new Error(clearError.message), {
        tags: { surface: "calendar_cancel_worker_clear_event_id" },
        extra: { ledgerId, sourceTaskId },
      });
    }
  }

  const finalized = await applyLedgerTransition(supabase, ledgerId, claimToken, "provider_done", {
    phase: "finalized",
    result_reason: resultReason,
    updated_at: nowIso(),
  });
  if (finalized.error) {
    const r = await markRetryableFailure(supabase, ledgerId, claimToken, "provider_done", finalized.error, 1);
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: finalized.error };
  }
  if (!finalized.applied) return { status: "lease_lost", ledgerId };

  return { status: "deleted", ledgerId };
}

// ----------------------------------------------------------------------------
// reschedule
// ----------------------------------------------------------------------------

/**
 * Updates the ledger-recorded event's time in place, under the (unchanged)
 * assignee's token, to the successor task's new due_at/end_at — then
 * CAS-moves google_calendar_event_id from the OLD (source) task to the NEW
 * (successor/target) task. Google's events.update/patch is naturally
 * idempotent for a repeated identical time write, so — unlike create's
 * events.insert — no client-supplied dedup id is needed here (the ledger
 * row carries none for reschedule).
 */
async function processClaimedReschedule(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;
  const targetTaskId = claimed.target_task_id;

  if (!targetTaskId || claimed.target_due_at === null || claimed.target_end_at === null) {
    // Structurally shouldn't happen — fn_reschedule_appointment always
    // sets target_task_id in the same transaction as the ledger row — but
    // fail permanently rather than CAS-writing an event id onto a task we
    // can't identify.
    const message = "reschedule ledger row has no target_task_id / target window";
    const r = await markPermanentFailure(supabase, ledgerId, claimToken, claimed.phase, message);
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "permanent_error", ledgerId, error: message };
  }

  if (claimed.phase === "provider_done") {
    try {
      const eventId = claimed.new_event_id ?? claimed.event_id;
      if (!eventId) {
        const message = "reschedule provider_done row has no event id to finalize";
        const r = await markPermanentFailure(supabase, ledgerId, claimToken, "provider_done", message);
        if (r.lost) return { status: "lease_lost", ledgerId };
        return { status: "permanent_error", ledgerId, error: message };
      }
      return await finalizeReschedule(
        supabase,
        ledgerId,
        claimToken,
        claimed.source_task_id,
        targetTaskId,
        claimed.expected_generation,
        eventId,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError(e, {
        tags: { surface: "calendar_reschedule_worker_resume" },
        extra: { ledgerId, sourceTaskId: claimed.source_task_id },
      });
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
        claimed.attempts,
      ).catch(() => ({ applied: false, lost: false }));
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: message };
    }
  }

  try {
    if (!claimed.event_id) {
      // No Google event ever existed for this appointment — nothing to
      // move. Immediate finalize.
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "no_event");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "no_event", ledgerId };
    }

    const token = await getDecryptedToken({
      userId: claimed.old_assignee_id,
      provider: "google",
      tokenType: "user",
    });
    if (!token) {
      // Codex round 1 fix: claimed.event_id EXISTS (see the !claimed.event_id
      // branch above) — the Google event is still out there with the OLD
      // due_at/end_at, not the successor's. Finalizing this as success would
      // leave that event silently stale forever. Retryable — same posture
      // as cancel's analogous fix.
      const message = "no token for old assignee; event may still exist at the old time";
      const r = await markStaleEventRetryable(
        supabase,
        ledgerId,
        claimToken,
        "no_token_stale_event",
        message,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "stale_event_needs_token", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.old_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    let eventId: string;
    try {
      const response = await calendar.events.patch({
        calendarId: "primary",
        eventId: claimed.event_id,
        requestBody: {
          start: { dateTime: claimed.target_due_at },
          end: { dateTime: claimed.target_end_at },
        },
      });
      eventId = response.data.id ?? claimed.event_id;
    } catch (e) {
      if (isGoogleNotFound(e)) {
        // The event was deleted out from under us (manually, or by a prior
        // crashed attempt somehow) — treat as no_event rather than
        // retrying forever against a target that will never come back.
        const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "no_event");
        if (r.lost) return { status: "lease_lost", ledgerId };
        return { status: "no_event", ledgerId };
      }
      return await handleProviderFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        e,
        claimed.attempts,
      );
    }

    const renewed = await renewLease(supabase, ledgerId, claimToken, "pending");
    if (renewed.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        renewed.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: renewed.error };
    }
    if (!renewed.applied) return { status: "lease_lost", ledgerId };

    const providerDone = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
      phase: "provider_done",
      new_event_id: eventId,
      result_reason: "event_updated",
      updated_at: nowIso(),
    });
    if (providerDone.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        providerDone.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: providerDone.error };
    }
    if (!providerDone.applied) return { status: "lease_lost", ledgerId };

    return await finalizeReschedule(
      supabase,
      ledgerId,
      claimToken,
      claimed.source_task_id,
      targetTaskId,
      claimed.expected_generation,
      eventId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "calendar_reschedule_worker" },
      extra: { ledgerId, sourceTaskId: claimed.source_task_id },
    });
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "pending",
      message,
      claimed.attempts,
    ).catch(() => ({ applied: false, lost: false }));
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: message };
  }
}

/**
 * CAS-attaches the (moved) event id onto the SUCCESSOR task
 * (expected_generation is the successor's own generation, 0 — a distinct
 * row/generation pair from the source's just-bumped value; see the
 * migration header) — this is the gating write; a lost CAS here means a
 * newer mutation on the successor won and is reported as finalize_conflict,
 * same contract as `finalizeCreation`. The source task's
 * google_calendar_event_id clear is best-effort cleanup afterward, guarded
 * on matching the specific event id being moved (not a generation CAS —
 * the source row is closed/terminal, its generation isn't tracked further)
 * so a source row that was somehow re-linked to a DIFFERENT event in the
 * meantime is never clobbered.
 */
async function finalizeReschedule(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  sourceTaskId: string,
  targetTaskId: string,
  expectedGeneration: number,
  eventId: string,
): Promise<CalendarMutationOutcome> {
  const { data: targetUpdated, error: targetUpdateError } = await supabase
    .from("tasks")
    .update({ google_calendar_event_id: eventId })
    .eq("id", targetTaskId)
    .eq("calendar_generation", expectedGeneration)
    .select("id")
    .maybeSingle();
  if (targetUpdateError) {
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "provider_done",
      targetUpdateError.message,
      1,
    );
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: targetUpdateError.message };
  }
  if (!targetUpdated) {
    return { status: "finalize_conflict", ledgerId, eventId, taskId: targetTaskId };
  }

  const { error: clearError } = await supabase
    .from("tasks")
    .update({ google_calendar_event_id: null })
    .eq("id", sourceTaskId)
    .eq("google_calendar_event_id", eventId);
  if (clearError) {
    reportError(new Error(clearError.message), {
      tags: { surface: "calendar_reschedule_worker_clear_source" },
      extra: { ledgerId, sourceTaskId },
    });
  }

  const finalized = await applyLedgerTransition(supabase, ledgerId, claimToken, "provider_done", {
    phase: "finalized",
    result_reason: "event_updated",
    updated_at: nowIso(),
  });
  if (finalized.error) {
    const r = await markRetryableFailure(supabase, ledgerId, claimToken, "provider_done", finalized.error, 1);
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: finalized.error };
  }
  if (!finalized.applied) return { status: "lease_lost", ledgerId };

  return { status: "updated", ledgerId, eventId };
}

// ----------------------------------------------------------------------------
// reassign
// ----------------------------------------------------------------------------

/**
 * Deletes the ledger-recorded event under the OLD assignee's token (404 =
 * idempotent success), then creates a fresh event under the NEW assignee's
 * token using the ledger row's deterministic `client_event_id` (R6-2,
 * same derivation as create) — finalizing via the same task-CAS +
 * ledger-finalize shape as `finalizeCreation` (wrapped as
 * `finalizeReassign` purely to report a distinct `reassigned` status for
 * sweep telemetry).
 */
async function processClaimedReassign(
  supabase: Supabase,
  claimed: ClaimedCalendarMutationRow,
): Promise<CalendarMutationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;
  const newAssigneeId = claimed.new_assignee_id;

  if (!newAssigneeId) {
    const message = "reassign ledger row has no new_assignee_id";
    const r = await markPermanentFailure(supabase, ledgerId, claimToken, claimed.phase, message);
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "permanent_error", ledgerId, error: message };
  }

  if (claimed.phase === "provider_done") {
    try {
      if (!claimed.new_event_id) {
        // Structurally shouldn't happen — see the analogous comment in
        // resumeProviderDoneCreation. Simpler fallback here (no
        // client-id reconcile branch): permanent-fail rather than
        // re-deriving via a second Google round trip.
        const message = "reassign provider_done row has no new_event_id to finalize";
        const r = await markPermanentFailure(supabase, ledgerId, claimToken, "provider_done", message);
        if (r.lost) return { status: "lease_lost", ledgerId };
        return { status: "permanent_error", ledgerId, error: message };
      }
      return await finalizeReassign(
        supabase,
        ledgerId,
        claimToken,
        claimed.source_task_id,
        claimed.expected_generation,
        claimed.new_event_id,
        claimed.result_reason === "reconciled_409",
        claimed.attempts,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError(e, {
        tags: { surface: "calendar_reassign_worker_resume" },
        extra: { ledgerId, sourceTaskId: claimed.source_task_id },
      });
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "provider_done",
        message,
        claimed.attempts,
      ).catch(() => ({ applied: false, lost: false }));
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: message };
    }
  }

  try {
    // Delete under the OLD account first. No client_event_id needed for a
    // delete — 404 is idempotent success (same contract as cancel).
    if (claimed.event_id) {
      const oldToken = await getDecryptedToken({
        userId: claimed.old_assignee_id,
        provider: "google",
        tokenType: "user",
      });
      if (oldToken) {
        try {
          const oldCalendar = buildCalendarClient(claimed.old_assignee_id, oldToken);
          await oldCalendar.events.delete({ calendarId: "primary", eventId: claimed.event_id });
        } catch (e) {
          if (!isGoogleNotFound(e)) {
            return await handleProviderFailure(
              supabase,
              ledgerId,
              claimToken,
              "pending",
              e,
              claimed.attempts,
            );
          }
          // 404 = already gone — fall through to the create-under-new-account step.
        }
      }
      // No old token: can't delete, but that must not block getting the new
      // assignee a working event — fall through (same "can't clean up what
      // we can't access" posture as cancel's no_token branch).
    }

    // Codex round 1 fix: claimed.event_id (truthy here) means an old event
    // existed that this reassign needs to migrate. If the NEW assignee's
    // calendar is disabled or unconnected, finalizing as success would
    // leave the appointment with NO calendar event anywhere (old
    // deleted-or-attempted, new never created) while the ledger claims the
    // operation is done — the same silent-stale-outcome bug as cancel/
    // reschedule. Only a reassign with NO old event to migrate (never
    // connected to Calendar in the first place) is a genuine clean no-op.
    const hadEventToMigrate = Boolean(claimed.event_id);

    const newPrefs = await loadIntegrationPrefs(supabase, newAssigneeId);
    if (!newPrefs.calendarEnabled) {
      if (hadEventToMigrate) {
        const message = "new assignee's calendar is disabled; old event was migrated to nowhere";
        const r = await markStaleEventRetryable(
          supabase,
          ledgerId,
          claimToken,
          "pref_disabled_stale_event",
          message,
          claimed.attempts,
        );
        if (r.lost) return { status: "lease_lost", ledgerId };
        return { status: "stale_event_needs_token", ledgerId, error: message };
      }
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "pref_disabled");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "pref_disabled", ledgerId };
    }

    const newToken = await getDecryptedToken({
      userId: newAssigneeId,
      provider: "google",
      tokenType: "user",
    });
    if (!newToken) {
      if (hadEventToMigrate) {
        const message = "no token for new assignee; old event was migrated to nowhere";
        const r = await markStaleEventRetryable(
          supabase,
          ledgerId,
          claimToken,
          "no_token_stale_event",
          message,
          claimed.attempts,
        );
        if (r.lost) return { status: "lease_lost", ledgerId };
        return { status: "stale_event_needs_token", ledgerId, error: message };
      }
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "no_token");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "no_token", ledgerId };
    }

    if (!claimed.client_event_id) {
      const message = "reassign ledger row has no client_event_id for the new-account create";
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    let newCalendar: CalendarClient;
    try {
      newCalendar = buildCalendarClient(newAssigneeId, newToken);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await markPermanentFailure(supabase, ledgerId, claimToken, "pending", message);
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "permanent_error", ledgerId, error: message };
    }

    let eventId: string;
    let reconciled = false;
    try {
      const response = await newCalendar.events.insert({
        calendarId: "primary",
        requestBody: buildEvent(
          claimed.client_event_id,
          claimed.source_title,
          claimed.source_due_at,
          claimed.source_end_at,
        ),
      });
      if (!response.data.id) throw new Error("Google returned no event id");
      eventId = response.data.id;
    } catch (e) {
      if (isGoogleConflict(e)) {
        try {
          const existing = await newCalendar.events.get({
            calendarId: "primary",
            eventId: claimed.client_event_id,
          });
          if (!existing.data.id) throw new Error("409-reconcile lookup returned no event id");
          eventId = existing.data.id;
          reconciled = true;
        } catch (reconcileError) {
          return await handleProviderFailure(
            supabase,
            ledgerId,
            claimToken,
            "pending",
            reconcileError,
            claimed.attempts,
          );
        }
      } else {
        return await handleProviderFailure(
          supabase,
          ledgerId,
          claimToken,
          "pending",
          e,
          claimed.attempts,
        );
      }
    }

    const renewed = await renewLease(supabase, ledgerId, claimToken, "pending");
    if (renewed.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        renewed.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: renewed.error };
    }
    if (!renewed.applied) return { status: "lease_lost", ledgerId };

    const providerDone = await applyLedgerTransition(supabase, ledgerId, claimToken, "pending", {
      phase: "provider_done",
      new_event_id: eventId,
      result_reason: reconciled ? "reconciled_409" : "event_created",
      updated_at: nowIso(),
    });
    if (providerDone.error) {
      const r = await markRetryableFailure(
        supabase,
        ledgerId,
        claimToken,
        "pending",
        providerDone.error,
        claimed.attempts,
      );
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "retryable_error", ledgerId, error: providerDone.error };
    }
    if (!providerDone.applied) return { status: "lease_lost", ledgerId };

    return await finalizeReassign(
      supabase,
      ledgerId,
      claimToken,
      claimed.source_task_id,
      claimed.expected_generation,
      eventId,
      reconciled,
      claimed.attempts,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "calendar_reassign_worker" },
      extra: { ledgerId, sourceTaskId: claimed.source_task_id },
    });
    const r = await markRetryableFailure(
      supabase,
      ledgerId,
      claimToken,
      "pending",
      message,
      claimed.attempts,
    ).catch(() => ({ applied: false, lost: false }));
    if (r.lost) return { status: "lease_lost", ledgerId };
    return { status: "retryable_error", ledgerId, error: message };
  }
}

/** Same CAS-onto-source-task + ledger-finalize shape as `finalizeCreation`
 *  (reused directly) — wrapped only to report the distinct `reassigned`
 *  status for sweep telemetry instead of `created`/`reconciled_409`. */
async function finalizeReassign(
  supabase: Supabase,
  ledgerId: string,
  claimToken: string,
  sourceTaskId: string,
  expectedGeneration: number,
  eventId: string,
  reconciled: boolean,
  attempts: number,
): Promise<CalendarMutationOutcome> {
  const base = await finalizeCreation(
    supabase,
    ledgerId,
    claimToken,
    sourceTaskId,
    expectedGeneration,
    eventId,
    reconciled,
    attempts,
  );
  if (base.status === "created" || base.status === "reconciled_409") {
    return { status: "reassigned", ledgerId, eventId: base.eventId };
  }
  return base;
}

// ----------------------------------------------------------------------------
// Google error classification (round 7)
//
// A bare HTTP status collapses cases that need different handling: a 403
// can mean "you'll never be allowed to do this" (insufficientPermissions,
// accessNotConfigured) or "you're allowed, just not right now"
// (rateLimitExceeded, userRateLimitExceeded). Terminal-failing the second
// case strands a row that would have succeeded on the next sweep; retrying
// the first case forever wastes attempts on a request that can never
// succeed. The Calendar API (and the OAuth2 token endpoint, for
// invalid_grant) surface a structured `reason` for exactly this — prefer
// it when present, and fall back to bare HTTP status only when it isn't.
// ----------------------------------------------------------------------------

/** Reasons observed on `err.response.data.error.errors[].reason` for the
 *  googleapis/gaxios error shape used throughout this file (same `status`/
 *  `code` fields as dispatch.ts's isGoogleConflict/isGoogleNotFound). */
const RETRYABLE_GOOGLE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
  "internalError",
]);

/** insufficientPermissions/accessNotConfigured/forbidden/authError are all
 *  credential- or grant-level failures that will never resolve by
 *  retrying; invalid_grant is the OAuth2 token-endpoint error shape (a
 *  bare string body, not an errors[] array — see extractGoogleReasons). */
const PERMANENT_GOOGLE_REASONS = new Set([
  "authError",
  "insufficientPermissions",
  "accessNotConfigured",
  "forbidden",
  "invalid_grant",
]);

type GoogleErrorLike = {
  status?: unknown;
  code?: unknown;
  response?: {
    data?: {
      error?:
        | string
        | {
            errors?: Array<{ reason?: unknown }>;
          };
    };
  };
};

function extractGoogleReasons(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const body = (error as GoogleErrorLike).response?.data?.error;
  if (!body) return [];
  if (typeof body === "string") return [body];
  if (!Array.isArray(body.errors)) return [];
  return body.errors
    .map((e) => (typeof e.reason === "string" ? e.reason : null))
    .filter((r): r is string => r !== null);
}

function extractGoogleStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

/**
 * Classify a Google API failure as retryable or permanent. Structured
 * `reason` values take priority over bare HTTP status when present; an
 * unrecognized/absent reason falls back to status (401 permanent, 429 and
 * all 5xx retryable). An unlisted 403 reason — including no reason at all
 * — defaults to RETRYABLE: exhaustion (attempts>=5,
 * fn_expire_exhausted_calendar_mutations) is what eventually terminalizes
 * a row that never actually recovers, which is a safer failure mode than
 * burying a transient block permanently on a guess.
 */
function classifyGoogleFailure(error: unknown): "retryable" | "permanent" {
  const reasons = extractGoogleReasons(error);
  if (reasons.some((r) => PERMANENT_GOOGLE_REASONS.has(r))) return "permanent";
  if (reasons.some((r) => RETRYABLE_GOOGLE_REASONS.has(r))) return "retryable";

  const status = extractGoogleStatus(error);
  if (status === 401) return "permanent";
  if (status === 429) return "retryable";
  if (typeof status === "number" && status >= 500 && status < 600) return "retryable";
  // status === 403 with no recognized reason, or any other/unknown shape:
  // fail toward retry.
  return "retryable";
}
