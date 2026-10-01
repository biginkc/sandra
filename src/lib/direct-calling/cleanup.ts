import type { DirectCallCleanupRow, DirectCallStore } from "./store";
import { TelnyxApiError, isLegAlreadyEnded, type ActiveCall } from "./telnyx";
import { hangupCommandId } from "./transitions";

/** Exponential backoff after EVERY attempt (success, failure, 429, error): 5s doubling to a 60s cap. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 60_000;
/** Up to this much upward jitter is added to a backoff (never shortens it). */
export const BACKOFF_JITTER = 0.2;
/** After the provider accepts a hangup (2xx) the leg is not re-checked sooner than this. */
export const ACK_RECHECK_MS = 10_000;
/** A claimed row is invisible to other processors for this long if the claimer dies mid-attempt. */
export const CLAIM_LEASE_SECS = 20;
/** An unresolved Dial is resolved by emptiness only after this many consecutive complete empty listings. */
export const EMPTY_MATCHES_TO_RESOLVE = 2;
/** Marker stored/logged when an unresolved Dial was resolved by its time-limit backstop alone. */
export const RESOLVED_BY_TIME_LIMIT = "resolved_by_time_limit";

export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(BACKOFF_CAP_MS, raw * (1 + BACKOFF_JITTER * random()));
}

export type CleanupDeps = {
  store: DirectCallStore;
  hangup: (callControlId: string, commandId: string) => Promise<void>;
  /** Provider status of one leg (GET call). Only `isAlive:false` confirms; an error confirms nothing. */
  getCall: (callControlId: string) => Promise<{ isAlive: boolean }>;
  /** Active calls on the Voice API app. `complete:false` means the listing was truncated. */
  listActiveCalls: () => Promise<{ calls: ActiveCall[]; complete: boolean }>;
  now: () => Date;
  report: (error: unknown, tag: string) => void;
  /** Jitter source; injectable for tests. */
  random?: () => number;
};

export type CleanupResult = {
  /** Rows acted on this pass (due and claimed). */
  processed: number;
  /** Rows confirmed/resolved this pass. */
  confirmed: number;
  /** Hangups the provider accepted (2xx) this pass; the leg is NOT yet confirmed. */
  acknowledged: number;
  /** Hangups, status checks or listings that errored; retried after backoff. */
  failed: number;
};

/**
 * The one place cleanup obligations are worked. Every trigger (webhook, status poll, start, explicit
 * hangup) just calls this for the operator. Rows are claimed atomically (store.claimDueCleanups pushes
 * next_attempt_at out by a lease), and every attempt then sets next_attempt_at by the backoff, so the
 * number of provider requests per row does not depend on how many callers trigger processing.
 *
 *  leg:             hangup (2xx = acked, NOT confirmed). Confirmed only by the leg's hangup webhook
 *                   (store.confirmLegCleanup), a 422/90018 "already ended" refusal, or GET is_alive:false.
 *  unresolved_dial: list active calls on the Voice API app and match this call's client_state; every match
 *                   becomes a leg row (hung up in the same pass). Resolved by emptiness only at/after
 *                   resolve_after (attempt + timeout + 15s) once two consecutive complete listings are empty,
 *                   and by time alone at backstop_at (attempt + time_limit + 60s).
 */
export async function processDueCleanups(deps: CleanupDeps, operatorUserId: string): Promise<CleanupResult> {
  const result: CleanupResult = { processed: 0, confirmed: 0, acknowledged: 0, failed: 0 };
  const { store } = deps;
  const claimed = await store.claimDueCleanups(operatorUserId, deps.now().toISOString(), CLAIM_LEASE_SECS);
  const dials = claimed.filter((r) => r.kind === "unresolved_dial");
  let legs = claimed.filter((r) => r.kind === "leg");

  // unresolved_dial first: a discovered leg becomes a leg row that is hung up in this same pass.
  for (const row of dials) {
    result.processed += 1;
    await reconcileDial(deps, row, result);
  }
  if (dials.length > 0) {
    const fresh = await store.claimDueCleanups(operatorUserId, deps.now().toISOString(), CLAIM_LEASE_SECS);
    legs = [...legs, ...fresh.filter((r) => r.kind === "leg")];
  }
  for (const row of legs) {
    result.processed += 1;
    await cleanLeg(deps, row, result);
  }
  return result;
}

async function settle(
  deps: CleanupDeps,
  row: DirectCallCleanupRow,
  patch: Parameters<DirectCallStore["updateCleanup"]>[1],
  options: { minDelayMs?: number; error?: unknown } = {},
) {
  const attempts = row.attempts + 1;
  const retryAfter = options.error instanceof TelnyxApiError ? (options.error.retryAfterMs ?? 0) : 0;
  const delay = Math.max(backoffMs(attempts, deps.random), options.minDelayMs ?? 0, retryAfter);
  await deps.store.updateCleanup(row.id, {
    attempts,
    next_attempt_at: new Date(deps.now().getTime() + delay).toISOString(),
    ...patch,
  });
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function confirm(deps: CleanupDeps, row: DirectCallCleanupRow, result: CleanupResult, note: string | null = null) {
  await settle(deps, row, { confirmed_at: deps.now().toISOString(), last_error: note });
  result.confirmed += 1;
}

async function cleanLeg(deps: CleanupDeps, row: DirectCallCleanupRow, result: CleanupResult) {
  const legId = row.leg_id;
  if (!legId) return;
  const sendHangup = async (): Promise<"accepted" | "gone" | { failed: unknown }> => {
    try {
      // The attempt number is part of the command id: a replay of this attempt dedupes, a later one does not.
      await deps.hangup(legId, hangupCommandId(row.direct_call_id, legId, row.attempts));
      return "accepted";
    } catch (error) {
      if (isLegAlreadyEnded(error)) return "gone";
      deps.report(error, "direct_call_hangup");
      return { failed: error };
    }
  };
  const afterHangup = async (outcome: Awaited<ReturnType<typeof sendHangup>>) => {
    if (outcome === "gone") return confirm(deps, row, result);
    if (outcome === "accepted") {
      result.acknowledged += 1;
      return settle(deps, row, { acked_at: deps.now().toISOString(), last_error: null }, { minDelayMs: ACK_RECHECK_MS });
    }
    result.failed += 1;
    return settle(deps, row, { last_error: message(outcome.failed) }, { error: outcome.failed });
  };
  try {
    if (!row.acked_at) return await afterHangup(await sendHangup());
    // Acknowledged earlier: confirm by status; if the leg is still alive, send the hangup again.
    let alive: boolean;
    try {
      alive = (await deps.getCall(legId)).isAlive;
    } catch (error) {
      deps.report(error, "direct_call_leg_status");
      result.failed += 1;
      return await settle(deps, row, { last_error: message(error) }, { error });
    }
    if (!alive) return await confirm(deps, row, result);
    return await afterHangup(await sendHangup());
  } catch (error) {
    // The bookkeeping write itself failed: the lease expires and the row is retried.
    deps.report(error, "direct_call_cleanup_persist");
    result.failed += 1;
  }
}

async function reconcileDial(deps: CleanupDeps, row: DirectCallCleanupRow, result: CleanupResult) {
  try {
    const now = deps.now().getTime();
    if (row.backstop_at && now >= new Date(row.backstop_at).getTime()) {
      deps.report(new Error(`Direct call ${row.dial_role} dial ${RESOLVED_BY_TIME_LIMIT}`), "direct_call_dial_backstop");
      return await confirm(deps, row, result, RESOLVED_BY_TIME_LIMIT);
    }
    let listing: Awaited<ReturnType<CleanupDeps["listActiveCalls"]>>;
    try {
      listing = await deps.listActiveCalls();
    } catch (error) {
      deps.report(error, "direct_call_dial_reconcile");
      result.failed += 1;
      return await settle(deps, row, { empty_matches: 0, last_error: message(error) }, { error });
    }
    const matches = listing.calls.filter((call) => call.clientState?.directCallId === row.direct_call_id);
    if (matches.length > 0) {
      for (const match of matches) await deps.store.addLegCleanup(row.direct_call_id, match.callControlId);
      return await confirm(deps, row, result);
    }
    // An incomplete listing, or a look before resolve_after, proves nothing: not an empty match.
    if (!listing.complete || (row.resolve_after && now < new Date(row.resolve_after).getTime())) {
      return await settle(deps, row, { empty_matches: 0, last_error: listing.complete ? null : "active_calls_listing_truncated" });
    }
    const empty = row.empty_matches + 1;
    if (empty >= EMPTY_MATCHES_TO_RESOLVE) {
      await settle(deps, row, { empty_matches: empty, confirmed_at: deps.now().toISOString(), last_error: null });
      result.confirmed += 1;
      return;
    }
    await settle(deps, row, { empty_matches: empty, last_error: null });
  } catch (error) {
    deps.report(error, "direct_call_cleanup_persist");
    result.failed += 1;
  }
}
