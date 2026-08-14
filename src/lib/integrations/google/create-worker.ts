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

const nowIso = () => new Date().toISOString();

/**
 * Process one claimed `task_calendar_mutations` row (operation='create',
 * phase='pending', already attempts-bumped by the claim RPC). Never
 * throws — every branch is a typed outcome; unexpected errors are caught,
 * reported, and treated as retryable (left `pending` with `last_error`
 * set) rather than silently swallowed or crashing the sweep.
 */
export async function processClaimedCalendarCreation(
  supabase: Supabase,
  claimed: ClaimedCalendarCreationRow,
): Promise<CalendarCreationOutcome> {
  const ledgerId = claimed.ledger_id;
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
          return await handleProviderFailure(supabase, ledgerId, reconcileError);
        }
      } else {
        return await handleProviderFailure(supabase, ledgerId, e);
      }
    }

    const { error: providerDoneError } = await supabase
      .from("task_calendar_mutations")
      .update({ phase: "provider_done", new_event_id: eventId, updated_at: nowIso() })
      .eq("id", ledgerId)
      .eq("phase", "pending");
    if (providerDoneError) {
      return { status: "retryable_error", ledgerId, error: providerDoneError.message };
    }

    // Finalize is compare-and-set on the task's current calendar_generation
    // (R6-2/R7-2 protocol) — a delayed retry (or a future lifecycle RPC
    // that moved generation) can never resurrect/attach an event out from
    // under a newer mutation.
    const { data: taskUpdated, error: taskUpdateError } = await supabase
      .from("tasks")
      .update({ google_calendar_event_id: eventId })
      .eq("id", claimed.source_task_id)
      .eq("calendar_generation", claimed.expected_generation)
      .select("id")
      .maybeSingle();
    if (taskUpdateError) {
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
      return { status: "retryable_error", ledgerId, error: finalizeError.message };
    }

    return reconciled
      ? { status: "reconciled_409", ledgerId, eventId }
      : { status: "created", ledgerId, eventId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "calendar_creation_worker" },
      extra: { ledgerId, sourceTaskId: claimed.source_task_id },
    });
    await markRetryableFailure(supabase, ledgerId, message).catch(() => {});
    return { status: "retryable_error", ledgerId, error: message };
  }
}

async function handleProviderFailure(
  supabase: Supabase,
  ledgerId: string,
  error: unknown,
): Promise<CalendarCreationOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  if (isGoogleAuthPermanent(error)) {
    await markPermanentFailure(supabase, ledgerId, message);
    return { status: "permanent_error", ledgerId, error: message };
  }
  // Fail closed toward "retryable" for anything not positively identified
  // as permanent — an unrecognized error shape leaving the row `pending`
  // (attempts already bumped by the claim) is safer than silently
  // terminal-failing a transient blip.
  await markRetryableFailure(supabase, ledgerId, message);
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
  const { error } = await supabase
    .from("task_calendar_mutations")
    .update({
      phase: "failed",
      result_reason: "auth_permanent",
      last_error: message,
      updated_at: nowIso(),
    })
    .eq("id", ledgerId)
    .eq("phase", "pending");
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
): Promise<void> {
  // Phase intentionally left as 'pending' — attempts was already bumped
  // by the claim RPC, so the exhaustion cap (attempts < 5) is what
  // eventually stops a permanently-broken row from being reclaimed
  // forever, not a phase transition here.
  const { error } = await supabase
    .from("task_calendar_mutations")
    .update({ last_error: message, updated_at: nowIso() })
    .eq("id", ledgerId)
    .eq("phase", "pending");
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
