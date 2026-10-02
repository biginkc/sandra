import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import type { BlandClient } from "./bland";
import type { DispatchResult } from "./dispatch";
import { withConvertedCallbackTime } from "./callback-wiring";
import type { CallbackTimeProvider } from "./callback-time";
import { mapBlandCallToOutcome } from "./outcome";
import { completeNormaCall, markNormaDispatchRejected, markNormaDispatchUnknown, markNormaNeedsReview } from "./rpc";
import { toUsVoiceE164 } from "./voice-phone";

const MIN = 60_000;

/** Thresholds (ms). Exported so tests and docs agree with the code. */
export const RECONCILE_THRESHOLDS = {
  /** A `requested` row younger than this is still being handled by its action. */
  requestedGrace: 1 * MIN,
  /** A `requested` row is still dispatched by the sweep only if younger than this; older is closed. */
  requestedExpiry: 5 * MIN,
  /** `dispatching` with no bound id this long means the sender died mid-send. */
  dispatchingStale: 2 * MIN,
  /** Wait this long after dispatch before asking Bland about a call. */
  dispatchedCheckAfter: 3 * MIN,
  /** A call with an id that is still unresolved this long is escalated. */
  escalateAfter: 60 * MIN,
  /** After a row is examined its next_check_at moves out by this, so stuck rows cannot starve fresh ones. */
  recheckAfter: 2 * MIN,
  recheckAfterRequested: 1 * MIN,
  recheckAfterNeedsReview: 55 * MIN,
  /** `dispatch_unknown` has no call id and Bland cannot be queried by metadata: escalate after this. */
  unknownNoIdEscalateAfter: 10 * MIN,
} as const;

export type ReconcileSummary = {
  scanned: number;
  dispatched: number;
  completed: number;
  rejected: number;
  markedUnknown: number;
  escalated: number;
  waiting: number;
  errors: number;
};

type Row = Pick<
  Database["public"]["Tables"]["norma_call_requests"]["Row"],
  "id" | "status" | "property_id" | "phone_e164" | "idempotency_key" | "bland_call_id" | "created_at" | "updated_at" | "outcome"
>;

export type ReconcileDeps = {
  client: SupabaseClient<Database>;
  bland: BlandClient | null;
  dispatch: (requestId: string) => Promise<DispatchResult>;
  now?: number;
  /** needs_review rows are rechecked on a slower cadence; the cron sets this hourly. */
  includeNeedsReview?: boolean;
  /** Optional AI step for the seller's callback words; the deterministic parser runs without it. */
  callbackTimeProvider?: CallbackTimeProvider | null;
};

const BATCH = 50;

export async function reconcileNormaCalls(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const now = deps.now ?? Date.now();
  const summary: ReconcileSummary = {
    scanned: 0, dispatched: 0, completed: 0, rejected: 0, markedUnknown: 0, escalated: 0, waiting: 0, errors: 0,
  };
  const statuses = ["requested", "dispatching", "dispatched", "dispatch_unknown", ...(deps.includeNeedsReview ? ["needs_review"] : [])];
  const { data, error } = await deps.client
    .from("norma_call_requests")
    .select("id, status, property_id, phone_e164, idempotency_key, bland_call_id, created_at, updated_at, outcome")
    .in("status", statuses)
    .lte("next_check_at", new Date(now).toISOString())
    .order("next_check_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`norma reconcile scan failed: ${error.message}`);

  for (const row of (data ?? []) as Row[]) {
    summary.scanned += 1;
    try {
      await reconcileRow(row, deps, now, summary);
    } catch (rowError) {
      summary.errors += 1;
      reportError(rowError, { tags: { surface: "norma_reconcile" }, extra: { requestId: row.id, status: row.status } });
    }
    // Whatever happened, this row goes to the back of the line. A scheduling
    // write failure must not abort the sweep (worst case: it is re-examined).
    try {
      const T = RECONCILE_THRESHOLDS;
      const delay = row.status === "needs_review" ? T.recheckAfterNeedsReview : row.status === "requested" ? T.recheckAfterRequested : T.recheckAfter;
      const { error: bumpError } = await deps.client
        .from("norma_call_requests")
        .update({ next_check_at: new Date(now + delay).toISOString() })
        .eq("id", row.id);
      if (bumpError) throw new Error(bumpError.message);
    } catch (bumpError) {
      reportError(bumpError, { tags: { surface: "norma_reconcile_schedule" }, extra: { requestId: row.id } });
    }
  }
  return summary;
}

async function reconcileRow(row: Row, deps: ReconcileDeps, now: number, summary: ReconcileSummary) {
  const T = RECONCILE_THRESHOLDS;
  const createdAge = now - Date.parse(row.created_at);
  const idleAge = now - Date.parse(row.updated_at);

  if (row.status === "requested") {
    if (createdAge < T.requestedGrace) return void (summary.waiting += 1);
    if (createdAge > T.requestedExpiry) {
      const closed = await markNormaDispatchRejected(deps.client, row.id, "stranded_requested_expired", "requested");
      // Claimed by a dispatcher in the meantime: not ours to close.
      return void (closed === "dispatch_rejected" ? (summary.rejected += 1) : (summary.waiting += 1));
    }
    const result = await deps.dispatch(row.id);
    if (result.status === "dispatched") summary.dispatched += 1;
    else if (result.status === "rejected") summary.rejected += 1;
    else if (result.status === "unknown") summary.markedUnknown += 1;
    else summary.waiting += 1;
    return;
  }

  if (row.status === "dispatching" && !row.bland_call_id) {
    if (idleAge < T.dispatchingStale) return void (summary.waiting += 1);
    // The sender may or may not have reached Bland. Fence, never redial.
    await markNormaDispatchUnknown(deps.client, row.id, "stranded_dispatching");
    return void (summary.markedUnknown += 1);
  }

  if (!row.bland_call_id) {
    // dispatch_unknown / needs_review with no id: Bland cannot be queried by
    // metadata, so nothing can resolve it but a human or a late webhook.
    if (row.status === "dispatch_unknown" && idleAge >= T.unknownNoIdEscalateAfter) {
      await markNormaNeedsReview(deps.client, row.id, "dispatch outcome unknown and no Bland call id");
      return void (summary.escalated += 1);
    }
    return void (summary.waiting += 1);
  }

  // From here the row has a Bland call id: ask Bland.
  if (row.status === "dispatched" && idleAge < T.dispatchedCheckAfter) return void (summary.waiting += 1);
  if (!deps.bland) return void (summary.waiting += 1);

  const lookup = await deps.bland.getCall(row.bland_call_id);
  if (lookup.kind === "found") {
    const call = lookup.call;
    const metadata = call.metadata && typeof call.metadata === "object" ? call.metadata : null;
    const keyMatches =
      !metadata || typeof metadata.idempotency_key !== "string" || metadata.idempotency_key.toLowerCase() === row.idempotency_key.toLowerCase();
    const idMatches = !call.call_id || call.call_id === row.bland_call_id;
    const numberMatches = toUsVoiceE164(typeof call.to === "string" ? call.to : null) === row.phone_e164;
    const matches = keyMatches && idMatches && numberMatches;
    if (!matches) {
      reportError(new Error("norma reconcile: Bland call does not match request"), {
        tags: { surface: "norma_reconcile" }, extra: { requestId: row.id },
      });
      summary.errors += 1;
      // Never applied, but never a dead end either: a lookup that keeps
      // disagreeing is as ambiguous as one that never answers, so it falls
      // through to the same escalation and the request cannot be stuck open.
    }
    if (matches && call.completed === true) {
      const mapping = await withConvertedCallbackTime(mapBlandCallToOutcome(call, now), {
        client: deps.client,
        propertyId: row.property_id,
        call,
        provider: deps.callbackTimeProvider,
        nowMs: deps.now,
      });
      // A needs_review row already holding an unknown result gains nothing.
      if (!(row.status === "needs_review" && mapping.outcome === "unknown")) {
        const result = await completeNormaCall(deps.client, {
          requestId: row.id, callId: row.bland_call_id, outcome: mapping.outcome, payload: mapping.payload,
        });
        if (result.result === "applied" || result.result === "replayed") return void (summary.completed += 1);
        throw new Error(`norma reconcile completion ${result.result}`);
      }
      return void (summary.waiting += 1);
    }
  }
  // Not found / not finished / lookup failed: ambiguous. Wait, then escalate.
  // Never redial, never resume.
  if (row.status !== "needs_review" && idleAge >= T.escalateAfter) {
    await markNormaNeedsReview(deps.client, row.id, "Bland call unresolved after the reconciliation window");
    return void (summary.escalated += 1);
  }
  summary.waiting += 1;
}
