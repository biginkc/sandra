import type { SupabaseClient } from "@supabase/supabase-js";
import type { calendar_v3 } from "googleapis";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import type { Database } from "@/lib/supabase/types";
import {
  buildCalendarClient,
  isGoogleConflict,
  type CalendarClient,
} from "./dispatch";

/**
 * PR-2 pull-forward of PR 3's durable calendar-mutation ledger consumer —
 * the `create`/`pending` slice only. `fn_book_appointment` (migration
 * 20260814170000) already opens a `task_calendar_mutations` row in the
 * same transaction as the appointment task; this worker is what actually
 * executes that intent against Google Calendar. Full plan:
 * reactive-puzzling-crane.md v9, "Calendar lifecycle = durable mutation
 * ledger" (PR 3 section) + R7-2 (terminal behavior for optional Calendar)
 * + R6-2 (provider-side idempotency via client-supplied event id).
 */

/** Row shape returned by `fn_claim_calendar_creations` — not in the
 *  generated Database["public"]["Functions"] map (same rationale as the
 *  booking RPCs: that regeneration belongs to whichever PR promotes this
 *  into the generated types). */
export type ClaimedCalendarCreationRow = {
  ledger_id: string;
  org_id: string;
  calendar_chain_id: string;
  source_task_id: string;
  expected_generation: number;
  client_event_id: string | null;
  attempts: number;
  /** Round 6: the claim RPC now also admits 'provider_done' rows (Google
   *  succeeded, finalize crashed before completing) — never anything else. */
  phase: "pending" | "provider_done";
  new_event_id: string | null;
  result_reason: string | null;
  /** Round 7 fencing token: minted fresh by the claim RPC on every
   *  claim/reclaim. Every write this worker makes to the row is scoped by
   *  this value — see the module-level fencing comment below. */
  claim_token: string;
  task_due_at: string;
  task_end_at: string;
  task_title: string;
  task_assignee_id: string;
};

export type CalendarCreationOutcome =
  | { status: "created"; ledgerId: string; eventId: string }
  | { status: "reconciled_409"; ledgerId: string; eventId: string }
  | { status: "pref_disabled"; ledgerId: string }
  | { status: "no_token"; ledgerId: string }
  | { status: "retryable_error"; ledgerId: string; error: string }
  | { status: "permanent_error"; ledgerId: string; error: string }
  /** Provider succeeded and `provider_done` was persisted, but the
   *  finalize CAS lost — the task's `calendar_generation` moved out from
   *  under this create between claim and finalize. Left at
   *  `provider_done`; never resurrected here. Extremely unlikely for a
   *  bare `create` (nothing can race it before PR 3's chain-serialization
   *  index admits a second mutation), guarded anyway for the same reason
   *  PR 3's real finalize CAS is guarded. */
  | { status: "finalize_conflict"; ledgerId: string; eventId: string }
  /** Round 7 fencing: this worker's claim_token (or expected phase) no
   *  longer matched the row at write time — another worker already
   *  reclaimed the expired lease and is (or already has) processed it.
   *  Not an error: the row is abandoned silently, ownership belongs to
   *  whoever holds the current token. */
  | { status: "lease_lost"; ledgerId: string };

type Supabase = SupabaseClient<Database>;

/** task_calendar_mutations.next_attempt_at / claim_token are added by this
 *  PR's migration (20260814170000) and, per this PR's scope, must not be
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
 * writing provider_done/new_event_id over the new owner.
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
 * Process one claimed `task_calendar_mutations` row, already
 * attempts-bumped and lease-stamped (with a fresh `claim_token`, round 7)
 * by the claim RPC. Never throws — every branch is a typed outcome;
 * unexpected errors are caught, reported, and treated as retryable (left
 * in place with `last_error` and a backed-off `next_attempt_at` set)
 * rather than silently swallowed or crashing the sweep.
 *
 * `phase='provider_done'` (round 6) means a prior attempt already created
 * the Google event but crashed before the task CAS / ledger finalize
 * completed — that path resumes without ever calling Google again.
 */
export async function processClaimedCalendarCreation(
  supabase: Supabase,
  claimed: ClaimedCalendarCreationRow,
): Promise<CalendarCreationOutcome> {
  const ledgerId = claimed.ledger_id;
  const claimToken = claimed.claim_token;
  if (claimed.phase === "provider_done") {
    return resumeProviderDoneCreation(supabase, claimed);
  }
  try {
    const prefs = await loadIntegrationPrefs(supabase, claimed.task_assignee_id);
    if (!prefs.calendarEnabled) {
      const r = await finalizeNoEvent(supabase, ledgerId, claimToken, "pref_disabled");
      if (r.lost) return { status: "lease_lost", ledgerId };
      return { status: "pref_disabled", ledgerId };
    }

    const token = await getDecryptedToken({
      userId: claimed.task_assignee_id,
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
      calendar = buildCalendarClient(claimed.task_assignee_id, token);
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
        requestBody: buildEvent(claimed),
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
  claimed: ClaimedCalendarCreationRow,
): Promise<CalendarCreationOutcome> {
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
      userId: claimed.task_assignee_id,
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
      calendar = buildCalendarClient(claimed.task_assignee_id, token);
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
 * provider_done resume path. The task CAS itself is unrelated to the
 * claim_token fence (it's scoped by `calendar_generation`, a different
 * concurrency axis entirely — PR 3's lifecycle mutations, not competing
 * creation workers); only the ledger finalize write below is
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
): Promise<CalendarCreationOutcome> {
  // Finalize is compare-and-set on the task's current calendar_generation
  // (R6-2/R7-2 protocol) — a delayed retry (or a future lifecycle RPC
  // that moved generation) can never resurrect/attach an event out from
  // under a newer mutation.
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
    return { status: "finalize_conflict", ledgerId, eventId };
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
): Promise<CalendarCreationOutcome> {
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

function buildEvent(claimed: ClaimedCalendarCreationRow): calendar_v3.Schema$Event {
  return {
    id: claimed.client_event_id ?? undefined,
    summary: claimed.task_title,
    start: { dateTime: claimed.task_due_at },
    end: { dateTime: claimed.task_end_at },
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
  reason: "pref_disabled" | "no_token",
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
  // fn_expire_exhausted_calendar_creations to terminalize) is what
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
 * fn_expire_exhausted_calendar_creations) is what eventually terminalizes
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
