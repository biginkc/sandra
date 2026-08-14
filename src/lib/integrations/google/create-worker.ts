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
  | { status: "finalize_conflict"; ledgerId: string; eventId: string };

type Supabase = SupabaseClient<Database>;

/** task_calendar_mutations.next_attempt_at is added by this PR's migration
 *  (20260814170000) and, per this PR's scope, must not be added to the
 *  generated Database["public"]["Tables"] map yet — same local-cast
 *  pattern used for the claim RPC row shape above and the booking RPCs'
 *  call sites. */
type LedgerLeaseUpdateClient = {
  from(table: "task_calendar_mutations"): {
    update(values: {
      last_error?: string;
      next_attempt_at?: string;
      updated_at?: string;
    }): {
      eq(column: "id", value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

const nowIso = () => new Date().toISOString();

/** Matches the claim RPC's flat 2-minute lease (migration 20260814170000).
 *  Worker-side backoff scales it by `attempts` so repeated failures push
 *  the row further out each time instead of retrying at a fixed interval. */
const RETRY_BACKOFF_UNIT_MS = 2 * 60 * 1000;

/**
 * Process one claimed `task_calendar_mutations` row, already
 * attempts-bumped and lease-stamped by the claim RPC. Never throws —
 * every branch is a typed outcome; unexpected errors are caught,
 * reported, and treated as retryable (left in place with `last_error` and
 * a backed-off `next_attempt_at` set) rather than silently swallowed or
 * crashing the sweep.
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
  if (claimed.phase === "provider_done") {
    return resumeProviderDoneCreation(supabase, claimed);
  }
  try {
    const prefs = await loadIntegrationPrefs(supabase, claimed.task_assignee_id);
    if (!prefs.calendarEnabled) {
      await finalizeNoEvent(supabase, ledgerId, "pref_disabled");
      return { status: "pref_disabled", ledgerId };
    }

    const token = await getDecryptedToken({
      userId: claimed.task_assignee_id,
      provider: "google",
      tokenType: "user",
    });
    if (!token) {
      await finalizeNoEvent(supabase, ledgerId, "no_token");
      return { status: "no_token", ledgerId };
    }

    if (!claimed.client_event_id) {
      // Structurally shouldn't happen — fn_book_appointment sets it in the
      // same transaction as the ledger row — but fail closed rather than
      // calling Google with an undefined id and creating an
      // unreconcilable event on retry.
      const message = "ledger row has no client_event_id";
      await markPermanentFailure(supabase, ledgerId, message);
      return { status: "permanent_error", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.task_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markPermanentFailure(supabase, ledgerId, message);
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
          return await handleProviderFailure(supabase, ledgerId, reconcileError, claimed.attempts);
        }
      } else {
        return await handleProviderFailure(supabase, ledgerId, e, claimed.attempts);
      }
    }

    // result_reason is written here too (not just at finalize) so a crash
    // between this write and the finalize below leaves a provider_done row
    // that a later resume (resumeProviderDoneCreation) can read back to
    // know whether the original attempt was a fresh create or a 409
    // reconcile, instead of guessing 'event_created' by default.
    const { error: providerDoneError } = await supabase
      .from("task_calendar_mutations")
      .update({
        phase: "provider_done",
        new_event_id: eventId,
        result_reason: reconciled ? "reconciled_409" : "event_created",
        updated_at: nowIso(),
      })
      .eq("id", ledgerId)
      .eq("phase", "pending");
    if (providerDoneError) {
      await markRetryableFailure(supabase, ledgerId, providerDoneError.message, claimed.attempts);
      return { status: "retryable_error", ledgerId, error: providerDoneError.message };
    }

    return await finalizeCreation(
      supabase,
      ledgerId,
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
    await markRetryableFailure(supabase, ledgerId, message, claimed.attempts).catch(() => {});
    return { status: "retryable_error", ledgerId, error: message };
  }
}

/**
 * Resume a claimed row already at phase='provider_done' (round 6): a
 * prior attempt's Google call succeeded but the process crashed before
 * the task CAS / ledger finalize completed. Never calls Google except in
 * the (structurally-shouldn't-happen) fallback where new_event_id itself
 * is missing — the normal case goes straight to finalizeCreation reusing
 * the recorded event id and result_reason.
 */
async function resumeProviderDoneCreation(
  supabase: Supabase,
  claimed: ClaimedCalendarCreationRow,
): Promise<CalendarCreationOutcome> {
  const ledgerId = claimed.ledger_id;
  let eventId = claimed.new_event_id;
  let reconciled = claimed.result_reason === "reconciled_409";

  if (!eventId) {
    if (!claimed.client_event_id) {
      const message =
        "provider_done ledger row has no new_event_id or client_event_id to reconcile";
      await markPermanentFailure(supabase, ledgerId, message);
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
      await markRetryableFailure(supabase, ledgerId, message, claimed.attempts);
      return { status: "retryable_error", ledgerId, error: message };
    }

    let calendar: CalendarClient;
    try {
      calendar = buildCalendarClient(claimed.task_assignee_id, token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markPermanentFailure(supabase, ledgerId, message);
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
      return await handleProviderFailure(supabase, ledgerId, e, claimed.attempts);
    }

    const { error: newEventIdError } = await supabase
      .from("task_calendar_mutations")
      .update({ new_event_id: eventId, result_reason: "reconciled_409", updated_at: nowIso() })
      .eq("id", ledgerId)
      .eq("phase", "provider_done");
    if (newEventIdError) {
      await markRetryableFailure(supabase, ledgerId, newEventIdError.message, claimed.attempts);
      return { status: "retryable_error", ledgerId, error: newEventIdError.message };
    }
  }

  return finalizeCreation(
    supabase,
    ledgerId,
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
 * provider_done resume path. Idempotent by construction: the finalize
 * update is scoped `.eq("phase", "provider_done")`, so calling this twice
 * against an already-finalized row (e.g. a resume racing a sweep that
 * already finished it) is a harmless no-op on the second call rather than
 * an error, and the CAS re-applying the same event id to an unchanged
 * generation is a no-op too.
 */
async function finalizeCreation(
  supabase: Supabase,
  ledgerId: string,
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
    await markRetryableFailure(supabase, ledgerId, taskUpdateError.message, attempts);
    return { status: "retryable_error", ledgerId, error: taskUpdateError.message };
  }
  if (!taskUpdated) {
    return { status: "finalize_conflict", ledgerId, eventId };
  }

  const { error: finalizeError } = await supabase
    .from("task_calendar_mutations")
    .update({
      phase: "finalized",
      result_reason: reconciled ? "reconciled_409" : "event_created",
      updated_at: nowIso(),
    })
    .eq("id", ledgerId)
    .eq("phase", "provider_done");
  if (finalizeError) {
    await markRetryableFailure(supabase, ledgerId, finalizeError.message, attempts);
    return { status: "retryable_error", ledgerId, error: finalizeError.message };
  }

  return reconciled
    ? { status: "reconciled_409", ledgerId, eventId }
    : { status: "created", ledgerId, eventId };
}

async function handleProviderFailure(
  supabase: Supabase,
  ledgerId: string,
  error: unknown,
  attempts: number,
): Promise<CalendarCreationOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  if (isGoogleAuthPermanent(error)) {
    await markPermanentFailure(supabase, ledgerId, message);
    return { status: "permanent_error", ledgerId, error: message };
  }
  // Fail closed toward "retryable" for anything not positively identified
  // as permanent — an unrecognized error shape left in place (attempts
  // already bumped, next_attempt_at backed off) is safer than silently
  // terminal-failing a transient blip.
  await markRetryableFailure(supabase, ledgerId, message, attempts);
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
 *  blocks a later lifecycle mutation. */
async function finalizeNoEvent(
  supabase: Supabase,
  ledgerId: string,
  reason: "pref_disabled" | "no_token",
): Promise<void> {
  const { error } = await supabase
    .from("task_calendar_mutations")
    .update({ phase: "finalized", result_reason: reason, updated_at: nowIso() })
    .eq("id", ledgerId)
    .eq("phase", "pending");
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "calendar_creation_worker_finalize_noop" },
      extra: { ledgerId, reason },
    });
  }
}

async function markPermanentFailure(
  supabase: Supabase,
  ledgerId: string,
  message: string,
): Promise<void> {
  // No `.eq("phase", ...)` guard — round 6 calls this from both the
  // 'pending' fresh-create path and the 'provider_done' resume path
  // (resumeProviderDoneCreation), and the claim lease already gives this
  // worker exclusive ownership of the row either way. A phase-scoped
  // filter here would silently no-op (0 rows matched, no error surfaced)
  // whenever called from the provider_done side, stranding the row.
  const { error } = await supabase
    .from("task_calendar_mutations")
    .update({
      phase: "failed",
      result_reason: "auth_permanent",
      last_error: message,
      updated_at: nowIso(),
    })
    .eq("id", ledgerId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "calendar_creation_worker_permanent_fail" },
      extra: { ledgerId },
    });
  }
}

async function markRetryableFailure(
  supabase: Supabase,
  ledgerId: string,
  message: string,
  attempts: number,
): Promise<void> {
  // Phase intentionally left as-is ('pending' or 'provider_done') — the
  // claim RPC already bumped attempts and set a flat 2-minute lease; this
  // explicitly pushes next_attempt_at out further, scaled by attempts, so
  // repeated failures back off instead of retrying at that same fixed
  // interval every sweep. The exhaustion cap (attempts < 5 to reclaim,
  // fn_expire_exhausted_calendar_creations to terminalize) is what
  // eventually stops a permanently-broken row from being reclaimed
  // forever — not a phase transition here. No `.eq("phase", ...)` guard:
  // the lease already gives this worker exclusive ownership of the row
  // for the backoff window, so nothing else can be racing this update.
  const nextAttemptAt = new Date(Date.now() + attempts * RETRY_BACKOFF_UNIT_MS).toISOString();
  const { error } = await (supabase as unknown as LedgerLeaseUpdateClient)
    .from("task_calendar_mutations")
    .update({ last_error: message, next_attempt_at: nextAttemptAt, updated_at: nowIso() })
    .eq("id", ledgerId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "calendar_creation_worker_retryable_fail" },
      extra: { ledgerId },
    });
  }
}

function extractGoogleStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function isGoogleAuthPermanent(error: unknown): boolean {
  const status = extractGoogleStatus(error);
  return status === 401 || status === 403;
}
