import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { delayToDate } from "@/lib/sequences/delays";
import { pauseEnrollment } from "@/lib/sequences/tick";
import type { Database, Json } from "@/lib/supabase/types";

import type {
  VoicemailDropCallbackEvent,
  VoicemailDropReasonClass,
  VoicemailDropStatusEvent,
} from "./types";

/**
 * Status updates for voicemail drops after the 202 (plan "Status updates",
 * RULING RVM-5). Both Drop Cowboy routes call into this module; the store
 * interface keeps the DB side swappable so every rule is unit-testable.
 */

export const DROPCOWBOY_PROVIDER_ID = "dropcowboy";
/** RVM-5: phone fallback only considers drops queued in the last 72h. */
export const PHONE_CORRELATION_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Bad credentials; arrives after the 202 and is a config problem. */
export const BAD_CREDENTIALS_REASON_CODE = 3007;

export const PAUSE_STEP_MISCONFIGURED = "step_misconfigured";
/** Visible consent-class pause (free-text pause_reason, migration 20261008143600). */
export const PAUSE_VOICEMAIL_DROP_CONSENT = "voicemail_drop_consent_blocked";

export type DropRow = {
  id: string;
  enrollment_id: string | null;
  step_run_id: string;
  status: string;
  attempt_outcome: string;
  drop_id: string | null;
};

/** recovery_action on a step run whose unknown POST was proven queued by Drop Cowboy. */
export const RECOVERY_VOICEMAIL_DROP_RECONCILED = "voicemail_drop_reconciled";

export type ReconcileResult = "not_held" | "reconciled";

export type DropPatch = Partial<{
  drop_id: string;
  status: "delivered" | "failed";
  reason_code: string | null;
  reason: string | null;
  proof_url: string;
  cost: number;
  provider_payload: Json;
  completed_at: string;
}>;

export interface DropStatusStore {
  findDropById(id: string): Promise<DropRow | null>;
  findDropsByDropId(dropId: string): Promise<DropRow[]>;
  findQueuedDropsByPhone(phone: string, sinceIso: string): Promise<DropRow[]>;
  /**
   * Patch a drop. With `onlyIfStatusIn`, the write is a compare-and-set on the
   * drop's current status; returns false when nothing matched.
   */
  updateDrop(id: string, patch: DropPatch, onlyIfStatusIn?: string[]): Promise<boolean>;
  /**
   * A drop held at attempt_outcome 'unknown' (POST answered 502/timeout) got a
   * callback or status event, which proves Drop Cowboy queued it. Do what the
   * 202 path would have done: step run unknown → accepted (claim stays
   * active), enrollment paused reconciliation_required → advanced, drop
   * attempt_outcome → queued. Never re-sends. Each write is a compare-and-set,
   * and the drop row is written last, so replays and crashes mid-way are safe.
   */
  reconcileHeldDrop(drop: DropRow): Promise<ReconcileResult>;
  pauseEnrollment(enrollmentId: string, reason: string): Promise<void>;
  /** Insert-or-claim the webhook_events row. "skip" = already handled / in flight. */
  reserveEvent(eventType: string, eventId: string, payload: Json): Promise<"reserved" | "skip">;
  finishEvent(eventType: string, eventId: string, outcome: "processed" | "error", message?: string): Promise<void>;
}

export type FailureAction = "pause_misconfigured" | "pause_consent" | "mark_failed" | "mark_failed_and_report";

export function failureActionFor(
  reasonCode: number | null,
  reasonClass: VoicemailDropReasonClass,
): FailureAction {
  if (reasonCode === BAD_CREDENTIALS_REASON_CODE || reasonClass === "config") return "pause_misconfigured";
  if (reasonClass === "consent") return "pause_consent";
  if (reasonClass === "delivery") return "mark_failed";
  return "mark_failed_and_report";
}

type Outcome = {
  status: "success" | "failure";
  reason: string | null;
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
};

function outcomePatch(o: Outcome, nowIso: string): DropPatch {
  return {
    status: o.status === "success" ? "delivered" : "failed",
    reason_code: o.reasonCode === null ? null : String(o.reasonCode),
    reason: o.reason,
    completed_at: nowIso,
  };
}

async function applyFailure(store: DropStatusStore, drop: DropRow, o: Outcome, surface: string) {
  if (o.status !== "failure") return;
  const action = failureActionFor(o.reasonCode, o.reasonClass);
  if (action === "pause_misconfigured" || action === "pause_consent") {
    if (drop.enrollment_id) {
      await store.pauseEnrollment(
        drop.enrollment_id,
        action === "pause_misconfigured" ? PAUSE_STEP_MISCONFIGURED : PAUSE_VOICEMAIL_DROP_CONSENT,
      );
    }
    return;
  }
  if (action === "mark_failed_and_report") {
    reportError(new Error(`voicemail drop failed with unclassified reason code ${o.reasonCode ?? "none"}`), {
      tags: { surface },
      extra: { dropRowId: drop.id, reasonCode: o.reasonCode, reason: o.reason },
    });
  }
}

/**
 * Apply a terminal outcome only while the drop is still queued (or already in
 * that same terminal state, for a replay). A late or replayed event never
 * flips delivered ↔ failed. Failure side effects run only on the
 * queued → failed transition.
 */
async function applyTerminalOutcome(
  store: DropStatusStore,
  drop: DropRow,
  o: Outcome,
  extra: DropPatch,
  nowIso: string,
  surface: string,
): Promise<void> {
  const patch: DropPatch = { ...extra, ...outcomePatch(o, nowIso) };
  const target = patch.status as "delivered" | "failed";
  if (drop.status !== "queued" && drop.status !== target) {
    // Keep the late event's non-outcome facts (drop id, proof, cost) only.
    const facts: DropPatch = { ...extra };
    delete facts.provider_payload;
    if (Object.keys(facts).length > 0) await store.updateDrop(drop.id, facts);
    return;
  }
  // queued → terminal is the only transition that runs side effects; a
  // same-state replay just refreshes the row.
  if (await store.updateDrop(drop.id, patch, ["queued"])) {
    await applyFailure(store, drop, o, surface);
    return;
  }
  await store.updateDrop(drop.id, patch, [target]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CallbackResult = { status: 200 | 404; body: Record<string, unknown> };

/** Unsigned callback_url payload. Only accepted for a foreign_id we issued. */
export async function handleDropCallback(
  store: DropStatusStore,
  event: VoicemailDropCallbackEvent,
  now: Date = new Date(),
): Promise<CallbackResult> {
  if (!event.foreignId || !UUID.test(event.foreignId)) return { status: 404, body: { error: "unknown_foreign_id" } };
  const drop = await store.findDropById(event.foreignId);
  if (!drop) return { status: 404, body: { error: "unknown_foreign_id" } };

  await store.reconcileHeldDrop(drop);
  const extra: DropPatch = { provider_payload: event.raw as Json };
  if (event.dropId) extra.drop_id = event.dropId;
  if (event.cost !== null) extra.cost = event.cost;
  if (event.proofUrl) extra.proof_url = event.proofUrl;
  await applyTerminalOutcome(store, drop, event, extra, now.toISOString(), "dropcowboy_rvm_callback_unclassified");
  return { status: 200, body: { ok: true } };
}

/** RVM-5 correlation: drop_id first, then a unique recent queued drop to that phone, else none. */
export async function correlateStatusEvent(
  store: DropStatusStore,
  event: VoicemailDropStatusEvent,
  now: Date,
): Promise<DropRow | null> {
  if (event.dropId) {
    const byDropId = await store.findDropsByDropId(event.dropId);
    if (byDropId.length === 1) return byDropId[0];
    if (byDropId.length > 1) return null;
  }
  const phone = normalizePhone(event.to);
  if (!phone) return null;
  const since = new Date(now.getTime() - PHONE_CORRELATION_WINDOW_MS).toISOString();
  const byPhone = await store.findQueuedDropsByPhone(phone, since);
  return byPhone.length === 1 ? byPhone[0] : null;
}

export type StatusWebhookResult = "duplicate" | "unmatched" | "applied";

/** Signed contact.rvm.status / contact.rvm.receipt. Signature is checked by the caller. */
export async function handleDropStatusEvent(
  store: DropStatusStore,
  event: VoicemailDropStatusEvent,
  now: Date = new Date(),
): Promise<StatusWebhookResult> {
  const eventType = event.kind === "receipt" ? "contact.rvm.receipt" : "contact.rvm.status";
  const reservation = await store.reserveEvent(eventType, event.eventId, event.raw as Json);
  if (reservation === "skip") return "duplicate";
  try {
    const drop = await correlateStatusEvent(store, event, now);
    if (!drop) {
      // Stored in webhook_events for a human to look at; never guess a drop.
      await store.finishEvent(eventType, event.eventId, "error", "unmatched voicemail drop");
      return "unmatched";
    }
    await store.reconcileHeldDrop(drop);
    const patch: DropPatch = {};
    if (event.dropId && !drop.drop_id) patch.drop_id = event.dropId;
    if (event.kind === "receipt") {
      if (event.proofUrl) patch.proof_url = event.proofUrl;
      if (Object.keys(patch).length > 0) await store.updateDrop(drop.id, patch);
    } else {
      await applyTerminalOutcome(store, drop, event, patch, now.toISOString(), "dropcowboy_rvm_webhook_unclassified");
    }
    await store.finishEvent(eventType, event.eventId, "processed");
    return "applied";
  } catch (error) {
    await store.finishEvent(eventType, event.eventId, "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const DROP_COLUMNS = "id, enrollment_id, step_run_id, status, attempt_outcome, drop_id";
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export function supabaseDropStatusStore(client: SupabaseClient<Database>): DropStatusStore {
  return {
    async findDropById(id) {
      const { data, error } = await client.from("voicemail_drops").select(DROP_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`findDropById: ${error.message}`);
      return data;
    },
    async findDropsByDropId(dropId) {
      const { data, error } = await client.from("voicemail_drops").select(DROP_COLUMNS).eq("drop_id", dropId).limit(2);
      if (error) throw new Error(`findDropsByDropId: ${error.message}`);
      return data ?? [];
    },
    async findQueuedDropsByPhone(phone, sinceIso) {
      const { data, error } = await client
        .from("voicemail_drops")
        .select(DROP_COLUMNS)
        .eq("to_phone", phone)
        .eq("status", "queued")
        // A drop held at attempt_outcome 'unknown' has no queued_at yet; its
        // window starts at created_at so a status event can still reconcile it.
        .or(`queued_at.gte.${sinceIso},and(queued_at.is.null,created_at.gte.${sinceIso})`)
        .limit(2);
      if (error) throw new Error(`findQueuedDropsByPhone: ${error.message}`);
      return data ?? [];
    },
    async updateDrop(id, patch, onlyIfStatusIn) {
      let query = client.from("voicemail_drops").update(patch).eq("id", id);
      if (onlyIfStatusIn) query = query.in("status", onlyIfStatusIn);
      const { data, error } = await query.select("id");
      if (error) throw new Error(`updateDrop: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async reconcileHeldDrop(drop) {
      return reconcileHeldDropWithClient(client, drop);
    },
    async pauseEnrollment(enrollmentId, reason) {
      const error = await pauseEnrollment(client, enrollmentId, reason, false);
      if (error) throw new Error(`pauseEnrollment: ${error}`);
    },
    async reserveEvent(eventType, eventId, payload) {
      const now = new Date().toISOString();
      const key = { provider: DROPCOWBOY_PROVIDER_ID, event_type: eventType, external_id: eventId };
      const { error } = await client.from("webhook_events").insert({
        ...key,
        signature_verified: true,
        processing_status: "processing",
        processing_started_at: now,
        payload,
      });
      if (!error) return "reserved";
      if (error.code !== "23505") throw new Error(`reserveEvent: ${error.message}`);
      const { data: existing, error: readError } = await client
        .from("webhook_events")
        .select("processing_status, processing_started_at")
        .match(key)
        .maybeSingle();
      if (readError) throw new Error(`reserveEvent: ${readError.message}`);
      if (!existing || existing.processing_status === "processed") return "skip";
      const started = existing.processing_started_at ? new Date(existing.processing_started_at).getTime() : 0;
      if (existing.processing_status === "processing" && Date.now() - started <= WEBHOOK_PROCESSING_LEASE_MS) {
        return "skip";
      }
      // Errored or lease-expired: claim it with a compare-and-set on the old state.
      let claim = client
        .from("webhook_events")
        .update({ processing_status: "processing", processing_started_at: now, processed_at: null, error_message: null })
        .match(key)
        .eq("processing_status", existing.processing_status);
      claim = existing.processing_started_at
        ? claim.eq("processing_started_at", existing.processing_started_at)
        : claim.is("processing_started_at", null);
      const { data: claimed, error: claimError } = await claim.select("id").maybeSingle();
      if (claimError) throw new Error(`reserveEvent: ${claimError.message}`);
      return claimed ? "reserved" : "skip";
    },
    async finishEvent(eventType, eventId, outcome, message) {
      const { error } = await client
        .from("webhook_events")
        .update({
          processing_status: outcome,
          processed_at: new Date().toISOString(),
          error_message: outcome === "error" ? (message ?? null) : null,
        })
        .match({ provider: DROPCOWBOY_PROVIDER_ID, event_type: eventType, external_id: eventId });
      if (error) throw new Error(`finishEvent: ${error.message}`);
    },
  };
}

/** Supabase side of DropStatusStore.reconcileHeldDrop (see the interface doc). */
export async function reconcileHeldDropWithClient(
  client: SupabaseClient<Database>,
  drop: DropRow,
): Promise<ReconcileResult> {
  // Held = POST outcome unknown, and the drop was actually posted (an
  // authorization failure before the POST leaves status 'skipped').
  if (drop.attempt_outcome !== "unknown" || drop.status !== "queued") return "not_held";
  const nowIso = new Date().toISOString();

  // 1. Step run: unknown → accepted, exactly as the 202 path writes it.
  const { data: run, error: runReadError } = await client
    .from("sequence_step_runs")
    .select("id, step_id, enrollment_id, attempt_outcome, claim_active")
    .eq("id", drop.step_run_id)
    .maybeSingle();
  if (runReadError) throw new Error(`reconcileHeldDrop run read: ${runReadError.message}`);
  if (!run || !run.claim_active || !["unknown", "accepted"].includes(run.attempt_outcome ?? "")) return "not_held";
  if (run.attempt_outcome === "unknown") {
    const { error } = await client
      .from("sequence_step_runs")
      .update({
        attempt_outcome: "accepted",
        skipped_reason: null,
        failure_reason: null,
        message_id: null,
        recovery_action: RECOVERY_VOICEMAIL_DROP_RECONCILED,
        recovery_evidence: "Drop Cowboy sent a status event for this drop, so the unknown POST was queued",
      })
      .eq("id", run.id)
      .eq("claim_active", true)
      .eq("attempt_outcome", "unknown");
    if (error) throw new Error(`reconcileHeldDrop run write: ${error.message}`);
  }

  // 2. Enrollment: paused reconciliation_required on this step → advanced
  //    (or completed), as advanceEnrollment does after a 202.
  const { data: step, error: stepError } = await client
    .from("sequence_steps")
    .select("sequence_id, step_index")
    .eq("id", run.step_id)
    .maybeSingle();
  if (stepError) throw new Error(`reconcileHeldDrop step read: ${stepError.message}`);
  if (step) {
    const { data: nextStep, error: nextError } = await client
      .from("sequence_steps")
      .select("delay_after_previous_minutes")
      .eq("sequence_id", step.sequence_id)
      .eq("step_index", step.step_index + 1)
      .maybeSingle();
    if (nextError) throw new Error(`reconcileHeldDrop next step read: ${nextError.message}`);
    const advance = nextStep
      ? {
          status: "active",
          pause_reason: null,
          current_step_index: step.step_index + 1,
          next_run_at: delayToDate(nextStep.delay_after_previous_minutes, new Date()).toISOString(),
          updated_at: nowIso,
        }
      : { status: "completed", pause_reason: null, completed_at: nowIso, next_run_at: null, updated_at: nowIso };
    const { error: advanceError } = await client
      .from("sequence_enrollments")
      .update(advance)
      .eq("id", run.enrollment_id)
      .eq("status", "paused")
      .eq("pause_reason", "reconciliation_required")
      .eq("current_step_index", step.step_index);
    if (advanceError) throw new Error(`reconcileHeldDrop advance: ${advanceError.message}`);
  }

  // 3. Drop row last: the marker that reconciliation finished.
  const { error: dropError } = await client
    .from("voicemail_drops")
    .update({ attempt_outcome: "queued", queued_at: nowIso })
    .eq("id", drop.id)
    .eq("attempt_outcome", "unknown");
  if (dropError) throw new Error(`reconcileHeldDrop drop write: ${dropError.message}`);
  drop.attempt_outcome = "queued";
  return "reconciled";
}
